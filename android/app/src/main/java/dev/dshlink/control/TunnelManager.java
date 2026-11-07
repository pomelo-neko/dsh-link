package dev.dshlink.control;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs the bundled frp STCP visitor (frpc) inside the app so a phone on any network can reach the
 * dsh-link hub (or node) through an STCP relay. frpc is shipped as libfrpc.so in the APK and
 * extracted by Android into nativeLibraryDir (the only app-owned directory Android 10+ allows to
 * execute).
 *
 * <p>The visitor configuration used to be baked into the APK under assets/tunnel/frpc.toml. Since
 * 0.5.0 the distribution build is credential-free and the configuration is imported at runtime
 * from a connection string minted by the hub administrator (see ConnectProfile): it lands in
 * filesDir/tunnel/frpc.toml and takes priority. A build that still bundles assets/tunnel keeps
 * working (internal deployments), and only when neither source exists does the app refuse to
 * start the tunnel with an actionable message.
 *
 * <p>The visitor's local bind port is always read from the frpc.toml that is actually used, so one
 * APK works for a node gateway (usually 18788) and for a hub (usually 18790).
 */
final class TunnelManager {
    private static final String TAG = "dshlink-tunnel";
    static final int DEFAULT_PORT = 18788;
    static final String NO_PROFILE_MESSAGE =
            "尚未导入隧道配置，请向 hub 管理员获取连接串/配置文件并导入";
    private static final long START_TIMEOUT_MS = 20000L;
    private static final Pattern BIND_PORT = Pattern.compile("(?m)^\\s*bindPort\\s*=\\s*(\\d+)");
    private static final Pattern ANSI_ESCAPE = Pattern.compile("\\u001B\\[[0-9;]*[A-Za-z]");
    private static final String[] TLS_FILES = {"ca.crt", "client.crt", "client.key"};

    private static Process process;
    private static File logFile;
    private static int localPort = DEFAULT_PORT;

    private TunnelManager() {}

    /** The frpc.toml imported from a connection profile (filesDir/tunnel/frpc.toml). */
    static File importedConfig(Context context) {
        return new File(context.getFilesDir(), "tunnel/frpc.toml");
    }

    static boolean hasImportedProfile(Context context) {
        return context != null && importedConfig(context).isFile();
    }

    /** Local URL of the STCP visitor, derived from the profile/asset config that would be used. */
    static synchronized String localUrl(Context context) {
        int port = currentPort(context);
        return "http://127.0.0.1:" + port;
    }

    static synchronized boolean isRunning() {
        return process != null && process.isAlive();
    }

    /** Parses the visitor's local bindPort out of an frpc.toml text. Returns 0 when absent. */
    static int parseBindPort(String toml) {
        if (toml == null || toml.isEmpty()) return 0;
        Matcher matcher = BIND_PORT.matcher(toml);
        int port = 0;
        while (matcher.find()) {
            try {
                port = Integer.parseInt(matcher.group(1));
            } catch (NumberFormatException ignored) {
            }
        }
        return port;
    }

    static synchronized void start(Context context) throws IOException {
        if (context == null) throw new IOException("应用上下文为空");

        File dir = new File(context.getFilesDir(), "tunnel");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建中转目录 " + dir);
        }

        // Imported profile first; the build-time asset is only an internal-deployment fallback.
        File imported = importedConfig(context);
        String template = null;
        boolean fromProfile = false;
        if (imported.isFile()) {
            template = readText(imported);
            fromProfile = true;
        } else {
            try {
                template = readAsset(context, "tunnel/frpc.toml");
            } catch (IOException ignored) {
                template = null;
            }
        }
        if (template == null || template.trim().isEmpty()) {
            throw new IOException(NO_PROFILE_MESSAGE);
        }
        int port = parseBindPort(template);
        if (port <= 0) port = DEFAULT_PORT;
        localPort = port;

        if (isRunning() && healthy()) return;
        stop();

        if (fromProfile) {
            // Only demand the certificate files the rendered frpc.toml actually references: a
            // profile may legitimately carry a subset (e.g. STCP secret only, no mutual TLS).
            for (String name : TLS_FILES) {
                if (template.contains("{{DIR}}/" + name) && !new File(dir, name).isFile()) {
                    throw new IOException("导入的隧道配置缺少 " + name + "，请重新导入连接串/配置文件");
                }
            }
        } else {
            copyAsset(context, "tunnel/ca.crt", new File(dir, "ca.crt"));
            copyAsset(context, "tunnel/client.crt", new File(dir, "client.crt"));
            copyAsset(context, "tunnel/client.key", new File(dir, "client.key"));
        }
        // Keep the imported frpc.toml verbatim (with its {{DIR}} placeholders); the render used by
        // frpc is written next to it as frpc.runtime.toml.
        File config = new File(dir, "frpc.runtime.toml");
        writeText(config, template.replace("{{DIR}}", dir.getAbsolutePath()));

        ApplicationInfo info = context.getApplicationInfo();
        File binary = new File(info.nativeLibraryDir, "libfrpc.so");
        if (!binary.isFile()) {
            throw new IOException("APK 中没有当前 CPU 架构的 frpc（nativeLibraryDir=" + info.nativeLibraryDir + "）");
        }
        if (!binary.canExecute() && !binary.setExecutable(true)) {
            Log.w(TAG, "frpc is not marked executable: " + binary);
        }

        logFile = new File(dir, "frpc.log");
        ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath(), "-c", config.getAbsolutePath());
        builder.directory(dir);
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile));
        Log.i(TAG, "starting " + binary + " -c " + config + " (" + (fromProfile ? "imported profile" : "bundled asset") + ")");
        process = builder.start();

        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (!process.isAlive()) break;
            if (healthy()) {
                Log.i(TAG, "tunnel is healthy on port " + localPort);
                return;
            }
            try {
                Thread.sleep(300L);
            } catch (InterruptedException err) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        String tail = readTail(logFile, 16000);
        stop();
        throw new IOException("frpc 未能在 " + (START_TIMEOUT_MS / 1000) + " 秒内建立中转。日志：\n" + tail);
    }

    static synchronized void stop() {
        if (process == null) return;
        Log.i(TAG, "stopping frpc");
        process.destroy();
        try {
            process.waitFor();
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
        }
        if (process.isAlive()) process.destroyForcibly();
        process = null;
    }

    /** Port of the configuration that the next start would use (imported profile, else asset). */
    private static int currentPort(Context context) {
        String toml = null;
        if (context != null) {
            File imported = importedConfig(context);
            if (imported.isFile()) {
                try {
                    toml = readText(imported);
                } catch (IOException err) {
                    Log.w(TAG, "cannot read imported frpc.toml: " + err);
                }
            }
        }
        if (toml == null && context != null) {
            try {
                toml = readAsset(context, "tunnel/frpc.toml");
            } catch (IOException err) {
                toml = null;
            }
        }
        int port = parseBindPort(toml);
        return port > 0 ? port : DEFAULT_PORT;
    }

    private static boolean healthy() {
        // The visitor's local port only accepts connections once frpc has logged in and attached the
        // STCP visitor. Probe it at the TCP level: the remote end may be a plain-HTTP node gateway, a
        // token-checking 8788 gateway, or the mTLS phone gateway (HTTPS with a self-signed CA). A TCP
        // connect is protocol-agnostic and therefore works for all three; HTTP probing broke the
        // phone gateway case because a plain HTTP request to an HTTPS listener always failed.
        Socket socket = null;
        try {
            socket = new Socket();
            socket.connect(new InetSocketAddress("127.0.0.1", localPort), 800);
            return true;
        } catch (IOException err) {
            return false;
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static void copyAsset(Context context, String name, File target) throws IOException {
        InputStream in = context.getAssets().open(name);
        OutputStream out = new FileOutputStream(target);
        try {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        } finally {
            try { in.close(); } finally { out.close(); }
        }
    }

    private static String readAsset(Context context, String name) throws IOException {
        InputStream in = context.getAssets().open(name);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    private static String readText(File file) throws IOException {
        InputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    private static void writeText(File file, String text) throws IOException {
        OutputStream out = new FileOutputStream(file);
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
    }

    private static String readTail(File file, int maxBytes) {
        if (file == null || !file.isFile()) return "(no log)";
        long length = file.length();
        long start = Math.max(0L, length - maxBytes);
        byte[] buffer = new byte[(int) (length - start)];
        try {
            FileInputStream in = new FileInputStream(file);
            try {
                long skipped = in.skip(start);
                if (skipped != start) return "(cannot read log)";
                int offset = 0;
                while (offset < buffer.length) {
                    int read = in.read(buffer, offset, buffer.length - offset);
                    if (read < 0) break;
                    offset += read;
                }
                return cleanLogTail(new String(buffer, 0, offset, StandardCharsets.UTF_8));
            } finally {
                in.close();
            }
        } catch (IOException err) {
            return "(cannot read log: " + err.getMessage() + ")";
        }
    }

    /**
     * frpc writes ANSI-coloured log lines; the colour codes are noise in an AlertDialog, and a
     * retry loop can log hundreds of lines before the 20 s timeout. Keep the last handful of
     * distinct lines so the dialog stays readable while still showing the actual error.
     */
    private static String cleanLogTail(String raw) {
        if (raw == null || raw.isEmpty()) return "(no log)";
        String text = ANSI_ESCAPE.matcher(raw).replaceAll("");
        String[] lines = text.split("\n", -1);
        StringBuilder builder = new StringBuilder();
        int first = Math.max(0, lines.length - 12);
        for (int i = first; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            builder.append(line).append('\n');
        }
        String result = builder.toString().trim();
        if (result.isEmpty()) return "(no log)";
        if (result.length() > 1200) result = result.substring(result.length() - 1200);
        return result;
    }
}
