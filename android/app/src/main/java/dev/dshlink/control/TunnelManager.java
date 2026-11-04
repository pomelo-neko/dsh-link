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
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs the bundled frp STCP visitor (frpc) inside the app so a phone on any network can reach the
 * dsh-link gateway through the Aliyun relay server. frpc is shipped as libfrpc.so in the APK and
 * extracted by Android into nativeLibraryDir (the only app-owned directory Android 10+ allows to
 * execute).
 *
 * The visitor's local bind port is read from the bundled assets/tunnel/frpc.toml template, so one
 * build works for both deployments: a node gateway usually binds 127.0.0.1:18788, a hub usually
 * binds 127.0.0.1:18790. Re-rendering the template (dshlink tunnel sync on the node/hub side) is
 * all it takes to switch the app to a hub, no Java change needed.
 */
final class TunnelManager {
    private static final String TAG = "dshlink-tunnel";
    private static final int DEFAULT_PORT = 18788;
    private static final long START_TIMEOUT_MS = 20000L;
    private static final Pattern BIND_PORT = Pattern.compile("(?m)^\\s*bindPort\\s*=\\s*(\\d+)");

    private static Process process;
    private static File logFile;
    private static int localPort = DEFAULT_PORT;
    private static boolean portResolved;

    private TunnelManager() {}

    /** Local URL of the STCP visitor, derived from the bundled template (18788 node / 18790 hub). */
    static synchronized String localUrl(Context context) {
        resolvePort(context);
        return "http://127.0.0.1:" + localPort;
    }

    static synchronized boolean isRunning() {
        return process != null && process.isAlive();
    }

    static synchronized void start(Context context) throws IOException {
        resolvePort(context);
        if (isRunning() && healthy()) return;
        stop();

        File dir = new File(context.getFilesDir(), "tunnel");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建中转目录 " + dir);
        }
        copyAsset(context, "tunnel/ca.crt", new File(dir, "ca.crt"));
        copyAsset(context, "tunnel/client.crt", new File(dir, "client.crt"));
        copyAsset(context, "tunnel/client.key", new File(dir, "client.key"));
        String template = readAsset(context, "tunnel/frpc.toml");
        File config = new File(dir, "frpc.toml");
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
        Log.i(TAG, "starting " + binary + " -c " + config);
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
        String tail = readTail(logFile, 4000);
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

    private static void resolvePort(Context context) {
        if (portResolved || context == null) return;
        try {
            String toml = readAsset(context, "tunnel/frpc.toml");
            Matcher matcher = BIND_PORT.matcher(toml);
            int port = 0;
            while (matcher.find()) port = Integer.parseInt(matcher.group(1));
            if (port > 0) localPort = port;
            portResolved = true;
            Log.i(TAG, "tunnel local port " + localPort);
        } catch (IOException | RuntimeException err) {
            Log.w(TAG, "cannot read tunnel/frpc.toml: " + err);
        }
    }

    private static boolean healthy() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL("http://127.0.0.1:" + localPort + "/healthz").openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(1200);
            conn.setRequestMethod("GET");
            int status = conn.getResponseCode();
            // The visitor port only answers once the tunnel is up. Past 0.7 it lands on the
            // token-checking gateway, which answers 401 to this unauthenticated probe - that
            // still proves the tunnel is connected, so any HTTP answer counts as healthy.
            return status > 0;
        } catch (IOException err) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
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
                return new String(buffer, 0, offset, StandardCharsets.UTF_8);
            } finally {
                in.close();
            }
        } catch (IOException err) {
            return "(cannot read log: " + err.getMessage() + ")";
        }
    }
}
