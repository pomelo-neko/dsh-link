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

/**
 * Minimal blocking dsh-link HTTP client. Every method must be called from a worker thread.
 * Both a 0.7+ node and a 0.8+ hub speak JSON over HTTP and expect
 * "Authorization: Bearer <device|admin token>"; a hub never trusts localhost, so the token is
 * always required.
 */
final class ApiClient {
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 60000;
    static final String APP_VERSION = "0.4.0";

    private final String baseUrl;
    private final String token;

    ApiClient(String rawBaseUrl, String token) {
        this.baseUrl = normalize(rawBaseUrl);
        this.token = token == null ? "" : token.trim();
    }

    String baseUrl() {
        return baseUrl;
    }

    JSONObject get(String path) throws ApiException {
        return call("GET", path, null);
    }

    JSONObject post(String path, JSONObject body) throws ApiException {
        return call("POST", path, body);
    }

    private JSONObject call(String method, String path, JSONObject body) throws ApiException {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(baseUrl + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "dshlink-control/" + APP_VERSION);
            if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(payload.length);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(payload);
                } finally {
                    out.close();
                }
            }
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = stream == null ? "" : readAll(stream);
            JSONObject json;
            try {
                json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException err) {
                throw new ApiException(status, "服务器返回的不是 JSON（HTTP " + status + "）", "bad_response");
            }
            if (status >= 400) throw new ApiException(status, errorMessage(json, status), errorCode(json));
            return json;
        } catch (ApiException err) {
            throw err;
        } catch (IOException err) {
            String reason = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
            throw new ApiException(0, "无法连接服务器：" + reason, "network_error");
        } catch (RuntimeException err) {
            String reason = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
            throw new ApiException(0, "请求失败：" + reason, "network_error");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String errorMessage(JSONObject json, int status) {
        JSONObject error = json.optJSONObject("error");
        if (error != null) {
            String message = error.optString("message", "").trim();
            if (!message.isEmpty()) return message;
        }
        return "请求失败（HTTP " + status + "）";
    }

    private static String errorCode(JSONObject json) {
        JSONObject error = json.optJSONObject("error");
        return error == null ? "" : error.optString("code", "");
    }

    static String normalize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }
}
