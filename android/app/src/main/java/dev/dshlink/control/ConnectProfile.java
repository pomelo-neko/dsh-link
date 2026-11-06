package dev.dshlink.control;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;
import java.util.zip.GZIPInputStream;

/**
 * 手机连接配置。支持两代连接串：
 *
 * <ul>
 *   <li><b>dshlink1:</b>（0.5.0 继承）gzip+base64 的 JSON，含 device token 与可选的内置隧道。
 *       导入后仍走 Bearer token 认证。</li>
 *   <li><b>dshlink2:</b>（0.6.0）gzip+base64 的 JSON v2，含 CA 证书、一次性 bootstrap 引导码与可选隧道。
 *       导入后先用引导码兑换服务器签发的设备证书，之后所有请求走 mTLS（见 {@link PhoneEnrollment}）。</li>
 * </ul>
 *
 * 两种连接串都允许直接粘贴裸 base64 码或 JSON 文本；解析只校验结构，不做网络请求。
 */
public final class ConnectProfile {

    private static final String TAG = "dshlink-profile";

    public static final String PREFIX = "dshlink1:";
    public static final String PREFIX_V2 = "dshlink2:";
    static final String KIND = "dshlink-phone";
    static final String KIND_V2 = "dshlink-phone-v2";
    static final int VERSION = 1;
    static final int VERSION_V2 = 2;

    /** 旧版 frpc.toml 缺失 bindPort 时的兜底端口。 */
    public static final int DEFAULT_TUNNEL_PORT = 18788;
    public static final int MAX_TEXT_CHARS = 4 * 1024 * 1024;

    static final String[] TLS_NAMES = {"ca.crt", "client.crt", "client.key"};

    public final int version;
    public final boolean certMode;
    public final String label;
    public final String entryKind;
    public final String entryName;
    public final String url;
    public final String token;
    public final String issuedAt;
    public final String expiresAt;
    public final String note;
    public final String softwareVersion;
    /** dshlink2：服务器自签 CA 的 PEM，作为唯一信任锚。 */
    public final String caPem;
    /** dshlink2：CA 证书 SHA-256 指纹（大写、冒号分隔）。 */
    public final String caFingerprint;
    public final String bootstrapId;
    public final String bootstrapSecret;
    public final String bootstrapExpiresAt;
    public final boolean hasTunnel;
    public final int tunnelBindPort;
    public final String frpc;
    public final JSONObject files;

    private ConnectProfile(JSONObject json, int version) throws IOException {
        this.version = version;
        this.certMode = version == VERSION_V2;
        this.issuedAt = optText(json, "issuedAt");
        this.expiresAt = optText(json, "expiresAt");
        this.note = optText(json, "note");
        this.softwareVersion = optText(json, "softwareVersion");

        JSONObject entry = json.optJSONObject("entry");
        if (entry == null) {
            throw new IOException("连接串缺少 entry 字段");
        }
        this.entryKind = entry.optString("kind", certMode ? "phone-gateway" : "node");
        this.entryName = firstNonEmpty(entry.optString("name", ""),
                certMode ? "hub" : "dshlink");
        this.url = firstNonEmpty(entry.optString("url", ""), "");
        if (this.url.isEmpty()) {
            throw new IOException("连接串缺少 entry.url");
        }
        if (certMode) {
            if (!this.url.startsWith("https://")) {
                throw new IOException("dshlink2 连接串的入口地址必须使用 https：" + this.url);
            }
        } else if (!this.url.startsWith("http://") && !this.url.startsWith("https://")) {
            throw new IOException("入口地址必须以 http:// 或 https:// 开头：" + this.url);
        }

        JSONObject tunnelObj = json.optJSONObject("tunnel");
        Tunnel tunnel = parseTunnel(tunnelObj, certMode);
        this.hasTunnel = tunnel != null;
        this.tunnelBindPort = tunnel == null ? 0 : tunnel.bindPort;
        this.frpc = tunnel == null ? "" : tunnel.frpc;
        this.files = tunnel == null ? new JSONObject() : tunnel.files;

        if (certMode) {
            this.token = "";
            JSONObject gateway = json.optJSONObject("gateway");
            if (gateway == null) {
                throw new IOException("dshlink2 连接串缺少 gateway 字段");
            }
            String ca = gateway.optString("caPem", "");
            if (ca == null || !ca.contains("BEGIN CERTIFICATE")) {
                throw new IOException("dshlink2 连接串的 gateway.caPem 不是有效的 CA 证书");
            }
            String declared = gateway.optString("caFingerprint", "");
            String computed = PhoneIdentity.fingerprintOfPem(ca, "");
            if (!declared.isEmpty() && !computed.isEmpty()
                    && !PhoneIdentity.sameFingerprint(declared, computed)) {
                throw new IOException("CA 证书指纹与连接串声明不一致（连接串可能被篡改或已损坏）");
            }
            this.caPem = ca;
            this.caFingerprint = computed.isEmpty() ? declared : computed;

            JSONObject bootstrap = json.optJSONObject("bootstrap");
            if (bootstrap == null) {
                throw new IOException("dshlink2 连接串缺少 bootstrap 一次性引导码");
            }
            String id = bootstrap.optString("id", "");
            String secret = bootstrap.optString("secret", "");
            if (id.isEmpty() || secret.isEmpty()) {
                throw new IOException("dshlink2 一次性引导码不完整（缺少 id 或 secret）");
            }
            this.bootstrapId = id;
            this.bootstrapSecret = secret;
            this.bootstrapExpiresAt = optText(bootstrap, "expiresAt");
            this.label = firstNonEmpty(json.optString("label", ""), this.entryName);
        } else {
            if (!KIND.equals(json.optString("kind", ""))) {
                throw new IOException("连接串类型不是 dshlink-phone（kind="
                        + json.optString("kind", "") + "）");
            }
            this.token = json.optString("token", "");
            if (this.token == null || this.token.trim().isEmpty()) {
                throw new IOException("dshlink1 连接串缺少 device token");
            }
            this.caPem = "";
            this.caFingerprint = "";
            this.bootstrapId = "";
            this.bootstrapSecret = "";
            this.bootstrapExpiresAt = "";
            String kind = entry.optString("kind", "node");
            this.label = firstNonEmpty(json.optString("label", ""), this.entryName);
        }
    }

    private static final class Tunnel {
        final int bindPort;
        final String frpc;
        final JSONObject files;

        Tunnel(int bindPort, String frpc, JSONObject files) {
            this.bindPort = bindPort;
            this.frpc = frpc;
            this.files = files;
        }
    }

    private static Tunnel parseTunnel(JSONObject tunnel, boolean certMode) throws IOException {
        if (tunnel == null) {
            return null;
        }
        if (!tunnel.optBoolean("enabled", true)) {
            return null;
        }
        String frpc = tunnel.optString("frpc", "");
        if (frpc == null || frpc.trim().isEmpty()) {
            throw new IOException("隧道配置缺少 frpc 内容（tunnel.frpc）");
        }
        JSONObject files = tunnel.optJSONObject("files");
        if (files == null) {
            files = new JSONObject();
        }
        int bindPort = TunnelManager.parseBindPort(frpc);
        if (bindPort <= 0) {
            bindPort = tunnel.optInt("bindPort", 0);
        }
        if (bindPort <= 0) {
            bindPort = DEFAULT_TUNNEL_PORT;
        }
        return new Tunnel(bindPort, frpc, files);
    }

    // ------------------------------------------------------------------ 解析入口

    public static ConnectProfile parse(String raw) throws IOException {
        if (raw == null) {
            throw new IOException("连接串为空");
        }
        String text = raw.trim();
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1).trim();
        }
        if (text.isEmpty()) {
            throw new IOException("连接串为空");
        }
        JSONObject json;
        if (text.startsWith("{")) {
            json = parseJson(text);
        } else {
            String code = text;
            if (code.startsWith(PREFIX_V2)) {
                code = code.substring(PREFIX_V2.length());
            } else if (code.startsWith(PREFIX)) {
                code = code.substring(PREFIX.length());
            }
            code = code.replaceAll("\\s+", "");
            if (code.isEmpty()) {
                throw new IOException("连接串内容为空（dshlink1:/dshlink2: 之后没有数据）");
            }
            json = parseJson(inflateText(code));
        }
        int v = json.optInt("v", 0);
        String kind = json.optString("kind", "");
        int version;
        if (v == VERSION_V2 || KIND_V2.equals(kind)) {
            version = VERSION_V2;
        } else if (v == VERSION || KIND.equals(kind)) {
            version = VERSION;
        } else {
            throw new IOException("不支持的连接串版本：v=" + v + " kind=" + kind
                    + "（本版本支持 dshlink1: 与 dshlink2:）");
        }
        return new ConnectProfile(json, version);
    }

    private static JSONObject parseJson(String text) throws IOException {
        try {
            return new JSONObject(text.trim());
        } catch (JSONException e) {
            throw new IOException("连接串 JSON 解析失败：" + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------ 状态 / 展示

    public boolean isCertMode() {
        return certMode;
    }

    public boolean isTokenMode() {
        return !certMode;
    }

    public boolean expired() {
        Instant expires = parseInstant(expiresAt);
        return expires != null && Instant.now().isAfter(expires);
    }

    public String expiresLabel() {
        return formatExpires(expiresAt);
    }

    public String bootstrapExpiresLabel() {
        return formatExpires(bootstrapExpiresAt);
    }

    public String summary() {
        StringBuilder sb = new StringBuilder();
        sb.append("标签：").append(firstNonEmpty(label, "未命名")).append('\n');
        sb.append("入口：").append(entryKindLabel()).append(' ').append(entryName);
        if (certMode) {
            sb.append("（手机网关）");
        }
        sb.append('\n');
        sb.append("地址：").append(url).append('\n');
        sb.append("安全模式：").append(certMode
                ? "每设备证书（mTLS，一次性引导）"
                : "device token（Bearer）").append('\n');
        if (certMode) {
            sb.append("CA 指纹：").append(caFingerprint.isEmpty() ? "（未知）" : caFingerprint).append('\n');
            sb.append("引导码：").append(bootstrapId);
            if (!bootstrapExpiresAt.isEmpty()) {
                sb.append("，到期 ").append(bootstrapExpiresLabel());
            }
            sb.append("（一次性，兑换成功后自动清除 secret）").append('\n');
        }
        sb.append("到期：").append(expiresLabel()).append('\n');
        sb.append("隧道：").append(hasTunnel
                ? "含内置隧道（本机 127.0.0.1:" + tunnelBindPort + "）"
                : "无隧道（直连）").append('\n');
        if (note != null && !note.trim().isEmpty()) {
            sb.append("备注：").append(note.trim());
        }
        return sb.toString().trim();
    }

    public String brief() {
        return firstNonEmpty(label, "dshlink") + " · "
                + (certMode ? "每设备证书" : "device token");
    }

    private String entryKindLabel() {
        if ("hub".equals(entryKind) || "phone-gateway".equals(entryKind)) {
            return "中心服务器";
        }
        return "节点";
    }

    public static String formatExpires(String iso) {
        if (iso == null || iso.trim().isEmpty()) {
            return "未提供";
        }
        Instant instant = parseInstant(iso);
        if (instant == null) {
            return iso;
        }
        String text = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
                .withZone(ZoneId.systemDefault())
                .format(instant);
        return Instant.now().isAfter(instant) ? text + "（已过期）" : text;
    }

    static Instant parseInstant(String iso) {
        if (iso == null || iso.trim().isEmpty()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(iso).toInstant();
        } catch (Exception ignored) {
            // 尝试下一种格式
        }
        try {
            return ZonedDateTime.parse(iso).toInstant();
        } catch (Exception ignored) {
            // 尝试下一种格式
        }
        try {
            return Instant.parse(iso);
        } catch (Exception ignored) {
            // 无法解析
        }
        return null;
    }

    // ------------------------------------------------------------------ 隧道文件落盘

    /**
     * 把连接串里的 frpc 配置与证书写入 files/tunnel，供 {@link TunnelManager} 使用。
     * 无隧道时删除旧文件，避免残留凭据被误用。
     */
    public void applyTunnelFiles(Context context) throws IOException {
        File dir = new File(context.getApplicationContext().getFilesDir(), "tunnel");
        deleteQuietly(new File(dir, "frpc.runtime.toml"));
        if (!hasTunnel) {
            deleteQuietly(new File(dir, "frpc.toml"));
            for (String name : TLS_NAMES) {
                deleteQuietly(new File(dir, name));
            }
            return;
        }
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建隧道配置目录：" + dir);
        }
        for (String name : TLS_NAMES) {
            deleteQuietly(new File(dir, name));
        }
        writeText(new File(dir, "frpc.toml"), frpc);
        Iterator<String> keys = files.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            String data = files.optString(name, "");
            String safe = safeFileName(name);
            if (safe == null) {
                throw new IOException("隧道配置文件包含非法文件名：" + name);
            }
            if (data.isEmpty()) {
                continue;
            }
            writeBytes(new File(dir, safe), decodeBase64(data));
        }
        Log.i(TAG, "隧道配置已写入：" + dir);
    }

    static String safeFileName(String name) {
        if (name == null || name.isEmpty() || name.length() > 100) {
            return null;
        }
        if (".".equals(name) || "..".equals(name)) {
            return null;
        }
        if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('\u0000') >= 0) {
            return null;
        }
        return name;
    }

    // ------------------------------------------------------------------ 编解码工具

    static byte[] decodeBase64(String value) throws IOException {
        String cleaned = value == null ? "" : value.replaceAll("\\s+", "");
        if (cleaned.isEmpty()) {
            return new byte[0];
        }
        cleaned = cleaned.replace('-', '+').replace('_', '/');
        int remainder = cleaned.length() % 4;
        if (remainder != 0) {
            StringBuilder padded = new StringBuilder(cleaned);
            for (int i = 0; i < 4 - remainder; i++) {
                padded.append('=');
            }
            cleaned = padded.toString();
        }
        try {
            return Base64.decode(cleaned, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new IOException("base64 解码失败：" + e.getMessage(), e);
        }
    }

    static String inflateText(String base64) throws IOException {
        byte[] compressed = decodeBase64(base64);
        if (compressed.length == 0) {
            throw new IOException("连接串内容为空");
        }
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = gzip.read(buffer)) > 0) {
                out.write(buffer, 0, n);
                if (out.size() > MAX_TEXT_CHARS) {
                    throw new IOException("连接串解压后超过 " + (MAX_TEXT_CHARS / 1024 / 1024) + "MB 上限");
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException gzipError) {
            String plain = new String(compressed, StandardCharsets.UTF_8).trim();
            if (plain.startsWith("{")) {
                return plain;
            }
            throw new IOException("连接串解压失败（不是有效的 dshlink1:/dshlink2: 连接串）："
                    + gzipError.getMessage(), gzipError);
        }
    }

    /** Android org.json 的 optString 会把 JSONObject.NULL 强制成字符串 "null"，这里统一归一为空串。 */
    static String optText(JSONObject json, String key) {
        if (json == null || json.isNull(key)) {
            return "";
        }
        String value = json.optString(key, "");
        if (value == null || "null".equals(value)) {
            return "";
        }
        return value.trim();
    }

    static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private static void writeText(File file, String text) throws IOException {
        writeBytes(file, text.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeBytes(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "删除文件失败：" + file);
        }
    }

    @SuppressWarnings("unused")
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    @SuppressWarnings("unused")
    private static String readText(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        }
    }
}
