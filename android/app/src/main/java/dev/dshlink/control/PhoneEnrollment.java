package dev.dshlink.control;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import javax.net.ssl.SSLContext;

/**
 * dshlink2 一次性引导：用连接串里的 bootstrap id/secret 兑换服务器签发的设备证书。
 *
 * <p>只把公钥（SPKI PEM）发给服务器，私钥始终留在本机。成功后就地保存 certPem 与
 * 设备指纹/到期时间，并立刻从存储中清除 bootstrap secret；连接串本身仍可用于同配置去重。</p>
 */
public final class PhoneEnrollment {

    private static final String TAG = "dshlink-phone";

    private PhoneEnrollment() {
    }

    public static boolean enrolled(Context context) {
        return PhoneIdentity.hasCertificate(context);
    }

    /**
     * 尚未持有设备证书时执行引导；已有证书则直接返回。
     *
     * @throws ApiException 引导失败（含网络/TLS/服务器拒绝），错误码见服务端契约
     */
    public static void enrollIfNeeded(Context context, String entryUrl) throws ApiException {
        if (PhoneIdentity.hasCertificate(context)) {
            return;
        }
        String caPem = PhoneIdentity.caPem(context);
        if (caPem.isEmpty()) {
            throw new ApiException(0,
                    "本机还没有导入 dshlink2 安全连接串（缺少 CA 证书）。请让 hub 管理员重新生成一次性引导码并导入。",
                    "no_profile");
        }
        String bootstrapId = PhoneIdentity.bootstrapId(context);
        String bootstrapSecret = PhoneIdentity.bootstrapSecret(context);
        if (bootstrapId == null || bootstrapId.isEmpty()
                || bootstrapSecret == null || bootstrapSecret.isEmpty()) {
            throw new ApiException(0,
                    "本机还没有设备证书，且导入的一次性引导码已被使用或已清除。请让 hub 管理员重新签发引导码，并重新导入 dshlink2 连接串。",
                    "no_certificate");
        }
        String base = ApiClient.normalize(entryUrl);
        if (base.isEmpty() || !base.startsWith("https://")) {
            throw new ApiException(0, "dshlink2 证书模式要求 https 入口地址，当前为：" + base,
                    "cert_setup");
        }

        String publicKeyPem;
        try {
            PhoneIdentity.KeyMaterial keyMaterial = PhoneIdentity.ensureKeyMaterial(context);
            publicKeyPem = keyMaterial.publicKeyPem;
            if (publicKeyPem == null || publicKeyPem.trim().isEmpty()) {
                throw new IllegalStateException("公钥为空");
            }
        } catch (Exception e) {
            throw new ApiException(0, "生成设备密钥失败：" + describe(e), "key_error");
        }

        JSONObject body = new JSONObject();
        try {
            JSONObject bootstrap = new JSONObject();
            bootstrap.put("id", bootstrapId);
            bootstrap.put("secret", bootstrapSecret);
            JSONObject device = new JSONObject();
            device.put("deviceId", PhoneIdentity.deviceId(context));
            device.put("label", PhoneIdentity.deviceLabel(context, null));
            device.put("platform", "android");
            device.put("appVersion", ApiClient.APP_VERSION);
            body.put("bootstrap", bootstrap);
            body.put("device", device);
            body.put("publicKey", publicKeyPem);
        } catch (JSONException e) {
            throw new ApiException(0, "构造引导请求失败：" + e.getMessage(), "cert_setup");
        }

        SSLContext sslContext;
        try {
            sslContext = PhoneIdentity.bootstrapContext(caPem);
        } catch (Exception e) {
            throw new ApiException(0, "读取导入的 CA 证书失败：" + describe(e), "cert_setup");
        }

        Log.i(TAG, "开始一次性引导：deviceId=" + PhoneIdentity.deviceId(context) + " entry=" + base);
        ApiClient client = new ApiClient(base, "", sslContext);
        JSONObject response;
        try {
            response = client.post("/api/v1/phone/bootstrap", body);
        } catch (ApiException e) {
            if (isFatalBootstrapCode(e.code)) {
                PhoneIdentity.clearBootstrapSecret(context);
            }
            Log.w(TAG, "引导失败：" + e.code + " / " + e.getMessage());
            throw e;
        }

        try {
            JSONObject certificate = response.optJSONObject("certificate");
            JSONObject device = response.optJSONObject("device");
            String certPem = certificate == null ? "" : certificate.optString("certPem", "");
            if (certPem.isEmpty() || !certPem.contains("BEGIN CERTIFICATE") || device == null) {
                throw new JSONException("响应缺少 certificate.certPem 或 device");
            }
            String fingerprint = device.optString("fingerprint", "");
            String validTo = device.optString("validTo", "");
            PhoneIdentity.setCertificate(context, certPem, fingerprint, validTo);
            // 引导码是一次性的：兑换成功立即清除 secret，只保留 id 用于同配置去重。
            PhoneIdentity.clearBootstrapSecret(context);
            Log.i(TAG, "引导成功：设备证书 " + fingerprint + "，到期 " + validTo);
        } catch (JSONException e) {
            throw new ApiException(0, "服务器返回的引导结果无法解析：" + e.getMessage(), "cert_setup");
        }
    }

    private static boolean isFatalBootstrapCode(String code) {
        return "bootstrap_rejected".equals(code)
                || "phone_bootstrap_expired".equals(code)
                || "phone_revoked".equals(code)
                || "phone_enrollment_closed".equals(code)
                || "too_many_attempts".equals(code)
                || "too_many_devices".equals(code)
                || "bad_public_key".equals(code)
                || "phone_gateway_disabled".equals(code);
    }

    private static String describe(Exception e) {
        if (e == null) {
            return "未知错误";
        }
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }
}
