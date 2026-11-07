package dev.dshlink.control;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;

/**
 * 极简 JSON HTTP 客户端（HttpURLConnection），支持两种安全模式：
 *
 * <ul>
 *   <li>token 模式（dshlink1:）：每个请求带 {@code Authorization: Bearer <device token>}。</li>
 *   <li>证书模式（dshlink2:）：调用方传入只信任导入 CA + 携带设备客户端证书的 {@link SSLContext}，
 *       请求不再携带 token（见 {@link PhoneIdentity#mutualTlsContext}）。</li>
 * </ul>
 */
public final class ApiClient {

    static final int CONNECT_TIMEOUT_MS = 8000;
    static final int READ_TIMEOUT_MS = 60000;
    public static final String APP_VERSION = "0.6.1";

    private final String baseUrl;
    private final String token;
    private final SSLContext sslContext;

    public ApiClient(String rawBaseUrl, String token) {
        this(rawBaseUrl, token, null);
    }

    public ApiClient(String rawBaseUrl, String token, SSLContext sslContext) {
        this.baseUrl = normalize(rawBaseUrl);
        this.token = token == null ? "" : token;
        this.sslContext = sslContext;
    }

    public String baseUrl() {
        return baseUrl;
    }

    public JSONObject get(String path) throws ApiException {
        return call("GET", path, null);
    }

    public JSONObject post(String path, JSONObject body) throws ApiException {
        return call("POST", path, body);
    }

    private JSONObject call(String method, String path, JSONObject body) throws ApiException {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(baseUrl + path);
            conn = (HttpURLConnection) url.openConnection();
            if (conn instanceof HttpsURLConnection) {
                HttpsURLConnection https = (HttpsURLConnection) conn;
                if (sslContext != null) {
                    https.setSSLSocketFactory(sslContext.getSocketFactory());
                }
                https.setHostnameVerifier(HttpsURLConnection.getDefaultHostnameVerifier());
            }
            conn.setRequestMethod(method);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "dshlink-control/" + APP_VERSION);
            if (!token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            byte[] payload = null;
            if (body != null) {
                payload = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setFixedLengthStreamingMode(payload.length);
            }
            conn.connect();
            if (payload != null) {
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                }
            }
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = stream == null ? "" : readAll(stream);
            if (status >= 400) {
                throw new ApiException(status, errorMessage(text, status), errorCode(text));
            }
            String trimmed = text.trim();
            if (trimmed.isEmpty()) {
                return new JSONObject();
            }
            try {
                return new JSONObject(trimmed);
            } catch (JSONException e) {
                throw new ApiException(status, "服务器返回了无法解析的 JSON：" + e.getMessage(),
                        "bad_response");
            }
        } catch (ApiException e) {
            throw e;
        } catch (SSLException e) {
            android.util.Log.e("dshlink-control", "TLS handshake failed for " + baseUrl + " method=" + method, e);
            Throwable cause = e.getCause();
            int depth = 0;
            while (cause != null && depth < 5) {
                android.util.Log.e("dshlink-control", "TLS cause[" + depth + "]: "
                        + cause.getClass().getName() + ": " + cause.getMessage());
                cause = cause.getCause();
                depth++;
            }
            throw new ApiException(0,
                    "TLS 握手失败：" + reason(e)
                            + "（请确认手机时间正确、导入的 CA 与服务器一致；证书模式若证书已被吊销或更换，请重新导入引导码）",
                    "tls_error");
        } catch (IOException e) {
            throw new ApiException(0, "无法连接服务器：" + reason(e), "network_error");
        } catch (RuntimeException e) {
            throw new ApiException(0, "请求失败：" + reason(e), "network_error");
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String errorMessage(String text, int status) {
        JSONObject error = parseError(text);
        if (error != null) {
            String message = error.optString("message", "");
            if (!message.isEmpty()) {
                return message;
            }
        }
        return "HTTP " + status;
    }

    static String errorCode(String text) {
        JSONObject error = parseError(text);
        return error == null ? "" : error.optString("code", "");
    }

    /** 兼容 {error:{code,message}} 与顶层 {code,message} 两种错误体。 */
    private static JSONObject parseError(String text) {
        if (text == null || text.trim().isEmpty()) {
            return null;
        }
        try {
            JSONObject json = new JSONObject(text.trim());
            JSONObject nested = json.optJSONObject("error");
            return nested != null ? nested : json;
        } catch (JSONException e) {
            return null;
        }
    }

    public static String normalize(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (!value.contains("://")) {
            value = "http://" + value;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static String reason(Exception e) {
        String message = e.getMessage();
        if (message == null || message.isEmpty()) {
            return e.getClass().getSimpleName();
        }
        return message;
    }
}
