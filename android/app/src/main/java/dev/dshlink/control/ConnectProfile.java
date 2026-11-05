package dev.dshlink.control;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * A connection profile minted by a dsh-link hub administrator and delivered as a "connection
 * string": dshlink1: + base64url(gzip(UTF-8 JSON)). Plain JSON file contents are accepted too, so
 * a user can open a .dshlink/.json file on the phone and paste what it contains.
 *
 * <p>The profile carries the entry address, the device token and - when the hub itself exposes an
 * STCP visitor for phones - the rendered frpc.toml plus the TLS certificates (as base64) needed to
 * reach it. Importing it is what lets a generic APK built without any bundled credentials connect
 * to a hub: everything secret arrives at runtime and lives in the app's private files directory.
 *
 * <p>Parsing is lenient by design (same rules as the hub-side encoder in src/phone.mjs): a
 * missing dshlink1: prefix, stray whitespace inside the code and a plain-JSON fallback for the
 * payload are all accepted, and a tunnel may carry only a subset of the three certificate files.
 */
final class ConnectProfile {
    static final String PREFIX = "dshlink1:";
    static final String KIND = "dshlink-phone";
    static final int VERSION = 1;
    static final int DEFAULT_TUNNEL_PORT = 18788;

    private static final String TAG = "dshlink-profile";
    private static final long MAX_TEXT_CHARS = 4L * 1024 * 1024;
    private static final String[] TLS_NAMES = {"ca.crt", "client.crt", "client.key"};

    final String label;
    final String entryKind; // "hub" or "node"
    final String entryName;
    final String url;
    final String token;
    final String issuedAt;
    final String expiresAt;
    final String note;
    final boolean hasTunnel;
    final int tunnelBindPort;
    private final String frpc;
    private final JSONObject files;

    private ConnectProfile(String label, String entryKind, String entryName, String url,
                           String token, String issuedAt, String expiresAt, String note,
                           boolean hasTunnel, int tunnelBindPort, String frpc, JSONObject files) {
        this.label = label;
        this.entryKind = entryKind;
        this.entryName = entryName;
        this.url = url;
        this.token = token;
        this.issuedAt = issuedAt;
        this.expiresAt = expiresAt;
        this.note = note;
        this.hasTunnel = hasTunnel;
        this.tunnelBindPort = tunnelBindPort;
        this.frpc = frpc;
        this.files = files;
    }

    /** Parses a pasted connection string or the contents of a .json/.dshlink profile file. */
    static ConnectProfile parse(String raw) throws IOException {
        String text = raw == null ? "" : raw.trim();
        if (text.startsWith("\uFEFF")) text = text.substring(1).trim();
        if (text.isEmpty()) {
            throw new IOException("内容为空：请粘贴 hub 管理员给你的连接串（dshlink1: 开头）或配置文件内容");
        }
        if (text.length() > MAX_TEXT_CHARS) {
            throw new IOException("连接配置过大（超过 4 MB），请检查粘贴的内容");
        }
        JSONObject json;
        if (text.startsWith("{")) {
            json = parseJson(text, "配置文件不是合法 JSON");
        } else {
            String body = text.startsWith(PREFIX) ? text.substring(PREFIX.length()) : text;
            body = body.replaceAll("\\s+", "");
            if (body.isEmpty()) throw new IOException("连接串为空：dshlink1: 后面没有内容");
            byte[] packed;
            try {
                packed = decodeBase64(body);
            } catch (IllegalArgumentException err) {
                throw new IOException("连接串不是合法的 dshlink1 编码（应为 dshlink1: + base64url，或 JSON 配置文件内容）");
            }
            json = inflate(packed);
        }
        return fromJson(json);
    }

    private static JSONObject inflate(byte[] packed) throws IOException {
        String gzipProblem = null;
        try {
            String text = new String(gunzip(packed), StandardCharsets.UTF_8);
            return parseJson(text, "连接串解压后不是合法 JSON");
        } catch (IOException err) {
            gzipProblem = err.getMessage();
        }
        // Older/simpler encoders may emit plain base64url(JSON); accept that too.
        try {
            String text = new String(packed, StandardCharsets.UTF_8).trim();
            if (text.startsWith("{")) return parseJson(text, "连接串不是合法 JSON");
        } catch (RuntimeException ignored) {
        }
        throw new IOException("连接串无法解析（既不是 gzip 压缩的 JSON，也不是 JSON 文本）：" + gzipProblem);
    }

    private static JSONObject parseJson(String text, String label) throws IOException {
        try {
            return new JSONObject(text);
        } catch (JSONException err) {
            throw new IOException(label + "：" + err.getMessage());
        }
    }

    private static ConnectProfile fromJson(JSONObject json) throws IOException {
        if (!KIND.equals(Ui.text(json, "kind"))) {
            throw new IOException("这不是 dsh-link 手机连接配置（kind=" + brief(Ui.text(json, "kind"))
                    + "，应为 " + KIND + "）");
        }
        if (json.optInt("v", 0) != VERSION) {
            throw new IOException("连接配置版本不支持（v=" + json.opt("v") + "，本机支持 v=" + VERSION + "），请升级 App");
        }
        JSONObject entry = json.optJSONObject("entry");
        if (entry == null) throw new IOException("连接配置缺少 entry（中心服务器/节点入口）");
        String url = ApiClient.normalize(Ui.text(entry, "url"));
        if (url.isEmpty()) throw new IOException("连接配置的 entry.url 为空");
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            throw new IOException("连接配置的 entry.url 不是 http(s) 地址：" + url);
        }
        String token = Ui.text(json, "token").trim();
        if (token.isEmpty()) {
            throw new IOException("连接配置没有设备 token，请让 hub 管理员重新生成连接串");
        }
        String entryKind = "node".equals(Ui.text(entry, "kind")) ? "node" : "hub";
        String label = Ui.text(json, "label");
        if (label.isEmpty()) label = Ui.text(entry, "name");
        if (label.isEmpty()) label = "node".equals(entryKind) ? "dsh-link 节点" : "dsh-link 中心服务器";

        String frpc = "";
        JSONObject files = null;
        boolean hasTunnel = false;
        int bindPort = 0;
        JSONObject tunnel = json.optJSONObject("tunnel");
        if (tunnel != null && tunnel.optBoolean("enabled", true)) {
            frpc = Ui.text(tunnel, "frpc");
            if (frpc.trim().isEmpty()) {
                throw new IOException("连接配置声明了隧道但 tunnel.frpc 为空，请让 hub 管理员重新生成");
            }
            hasTunnel = true;
            files = tunnel.optJSONObject("files");
            bindPort = TunnelManager.parseBindPort(frpc);
            if (bindPort <= 0) bindPort = tunnel.optInt("bindPort", DEFAULT_TUNNEL_PORT);
            if (bindPort <= 0) bindPort = DEFAULT_TUNNEL_PORT;
        }
        return new ConnectProfile(label, entryKind, Ui.text(entry, "name"), url, token,
                Ui.text(json, "issuedAt"), Ui.text(json, "expiresAt"), Ui.text(json, "note"),
                hasTunnel, bindPort, frpc, files);
    }

    /** True when the profile carries an expiry timestamp that is already in the past. */
    boolean expired() {
        if (expiresAt.isEmpty()) return false;
        try {
            return Instant.parse(expiresAt).isBefore(Instant.now());
        } catch (RuntimeException err) {
            return false;
        }
    }

    String expiresLabel() {
        return formatExpires(expiresAt);
    }

    static String formatExpires(String iso) {
        if (iso == null || iso.isEmpty()) return "长期有效";
        try {
            Instant instant = Instant.parse(iso);
            String text = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.ROOT)
                    .withZone(ZoneId.systemDefault()).format(instant);
            return instant.isBefore(Instant.now()) ? text + "（已过期）" : text;
        } catch (RuntimeException err) {
            return iso;
        }
    }

    /**
     * Writes the imported tunnel profile under filesDir/tunnel: frpc.toml (kept verbatim with its
     * {{DIR}} placeholders; TunnelManager substitutes them when it starts frpc) plus every
     * certificate file the profile carries. A profile without a tunnel clears the previous one,
     * so a later import always wins over stale credentials.
     */
    void applyTunnelFiles(Context context) throws IOException {
        if (context == null) throw new IOException("应用上下文为空，无法保存隧道配置");
        File dir = new File(context.getFilesDir(), "tunnel");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建隧道配置目录 " + dir);
        }
        File imported = new File(dir, "frpc.toml");
        deleteQuietly(new File(dir, "frpc.runtime.toml"));
        if (!hasTunnel) {
            deleteQuietly(imported);
            for (String name : TLS_NAMES) deleteQuietly(new File(dir, name));
            Log.i(TAG, "imported profile has no tunnel; cleared previous tunnel files");
            return;
        }
        for (String name : TLS_NAMES) deleteQuietly(new File(dir, name));
        writeText(imported, frpc);
        if (files != null) {
            Iterator<String> keys = files.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                if (!safeFileName(name)) {
                    Log.w(TAG, "ignoring tunnel file with unsafe name: " + name);
                    continue;
                }
                byte[] data;
                try {
                    data = decodeBase64(files.optString(name, ""));
                } catch (IllegalArgumentException err) {
                    throw new IOException("隧道文件 " + name + " 不是合法的 base64，请让 hub 管理员重新生成连接串");
                }
                writeBytes(new File(dir, name), data);
            }
        }
        Log.i(TAG, "stored tunnel profile in " + dir);
    }

    /** Multi-line Chinese summary shown after a successful import. */
    String summary() {
        StringBuilder out = new StringBuilder();
        out.append("标签：").append(label).append('\n');
        out.append("入口：").append("node".equals(entryKind) ? "节点" : "中心服务器");
        if (!entryName.isEmpty()) out.append(" · ").append(entryName);
        out.append('\n');
        out.append("地址：").append(url).append('\n');
        out.append("到期：").append(expiresLabel()).append('\n');
        if (hasTunnel) {
            out.append("隧道：含 STCP 中转凭据（本机 127.0.0.1:").append(tunnelBindPort).append("）");
        } else {
            out.append("隧道：无（直接连接入口地址）");
        }
        if (!note.isEmpty()) out.append('\n').append("备注：").append(note);
        return out.toString();
    }

    private static String brief(String value) {
        if (value == null) return "";
        String text = value.trim();
        return text.length() <= 40 ? text : text.substring(0, 40) + "…";
    }

    private static boolean safeFileName(String name) {
        if (name == null || name.isEmpty() || name.length() > 64) return false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) return false;
        }
        return !name.equals(".") && !name.equals("..");
    }

    /** Decodes standard or URL-safe base64 with or without padding. */
    static byte[] decodeBase64(String value) {
        String compact = value == null ? "" : value.replaceAll("\\s+", "");
        compact = compact.replace('-', '+').replace('_', '/').replaceAll("=+$", "");
        if (compact.isEmpty()) return new byte[0];
        int remainder = compact.length() % 4;
        if (remainder == 1) throw new IllegalArgumentException("bad base64 length");
        StringBuilder padded = new StringBuilder(compact);
        if (remainder == 2) padded.append("==");
        else if (remainder == 3) padded.append('=');
        return Base64.decode(padded.toString(), Base64.DEFAULT);
    }

    private static byte[] gunzip(byte[] packed) throws IOException {
        GZIPInputStream in;
        try {
            in = new GZIPInputStream(new ByteArrayInputStream(packed));
        } catch (IOException err) {
            throw new IOException("数据不是 gzip 压缩格式", err);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void writeText(File file, String text) throws IOException {
        writeBytes(file, text.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeBytes(File file, byte[] data) throws IOException {
        OutputStream out = new FileOutputStream(file);
        try {
            out.write(data);
        } finally {
            out.close();
        }
    }

    private static void deleteQuietly(File file) {
        if (file.exists() && !file.delete()) Log.w(TAG, "cannot delete " + file);
    }
}
