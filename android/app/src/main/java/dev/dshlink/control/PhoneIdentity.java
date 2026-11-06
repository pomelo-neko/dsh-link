package dev.dshlink.control;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.CertificateParsingException;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Locale;
import java.util.UUID;

import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.net.ssl.X509TrustManager;

import java.net.Socket;

/**
 * 0.6.0 手机安全身份：dshlink2 每设备证书模式的持久化、密钥管理与 mTLS 支持。
 *
 * <p>安全模式：</p>
 * <ul>
 *   <li>{@link #MODE_TOKEN}（0.5.0 继承）：dshlink1: 连接串 + device token（Bearer），行为与旧版一致。</li>
 *   <li>{@link #MODE_CERT}（0.6.0 新增）：dshlink2: 连接串，一次性引导兑换服务器签发的设备证书，
 *       此后所有请求走双向 TLS（客户端证书 + 只信任连接串内 CA）。</li>
 * </ul>
 *
 * <p>设备私钥优先存放在 AndroidKeyStore（硬件/系统密钥库，不可导出）；在模拟器或个别设备上
 * KeyStore 不可用时回退为 app 私有目录下的软件 PKCS#8 文件，并在 UI/README 中提示风险。
 * 服务器永远只会收到公钥（引导时提交 SPKI），私钥不出本机。</p>
 */
public final class PhoneIdentity {

    private static final String TAG = "dshlink-phone";

    /** 与 MainActivity 共用同一个 SharedPreferences 文件。 */
    public static final String PREFS = "dshlink";

    public static final String MODE_TOKEN = "token";
    public static final String MODE_CERT = "cert";

    public static final String KEY_SECURE_MODE = "profile.secureMode";
    public static final String KEY_CA_PEM = "phone.caPem";
    public static final String KEY_CA_FINGERPRINT = "phone.caFingerprint";
    public static final String KEY_DEVICE_ID = "phone.deviceId";
    public static final String KEY_DEVICE_LABEL = "phone.deviceLabel";
    public static final String KEY_CERT_PEM = "phone.certPem";
    public static final String KEY_CERT_FINGERPRINT = "phone.certFingerprint";
    public static final String KEY_CERT_VALID_TO = "phone.certValidTo";
    public static final String KEY_KEY_STORAGE = "phone.keyStorage";
    public static final String KEY_PUBLIC_KEY_PEM = "phone.publicKeyPem";
    public static final String KEY_BOOTSTRAP_ID = "phone.bootstrapId";
    public static final String KEY_BOOTSTRAP_SECRET = "phone.bootstrapSecret";
    public static final String KEY_BOOTSTRAP_EXPIRES_AT = "phone.bootstrapExpiresAt";

    public static final String SERVER_AUTH_EKU = "1.3.6.1.5.5.7.3.1";

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "dshlink-phone-key";
    private static final String SOFTWARE_KEY_FILE = "phone-key.pk8";
    private static final String SOFTWARE_DIR = "phone";
    private static final String STORAGE_KEYSTORE = "keystore";
    private static final String STORAGE_SOFTWARE = "software";

    private PhoneIdentity() {
    }

    // ------------------------------------------------------------------ prefs

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean certMode(Context context) {
        return MODE_CERT.equals(prefs(context).getString(KEY_SECURE_MODE, MODE_TOKEN));
    }

    public static void setSecureMode(Context context, String mode) {
        prefs(context).edit().putString(KEY_SECURE_MODE,
                MODE_CERT.equals(mode) ? MODE_CERT : MODE_TOKEN).apply();
    }

    public static void clearSecureMode(Context context) {
        prefs(context).edit().remove(KEY_SECURE_MODE).apply();
    }

    /** 首次生成并持久化的随机 UUID，绑定到服务器签发的证书 CN；重装 app 会更换。 */
    public static String deviceId(Context context) {
        SharedPreferences p = prefs(context);
        String id = p.getString(KEY_DEVICE_ID, "");
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString();
            p.edit().putString(KEY_DEVICE_ID, id).apply();
        }
        return id;
    }

    public static void setDeviceLabel(Context context, String label) {
        if (label == null || label.trim().isEmpty()) {
            prefs(context).edit().remove(KEY_DEVICE_LABEL).apply();
        } else {
            prefs(context).edit().putString(KEY_DEVICE_LABEL, label.trim()).apply();
        }
    }

    public static String deviceLabel(Context context, String fallback) {
        String stored = prefs(context).getString(KEY_DEVICE_LABEL, "");
        if (stored != null && !stored.trim().isEmpty()) {
            return stored.trim();
        }
        if (fallback != null && !fallback.trim().isEmpty()) {
            return fallback.trim();
        }
        String model = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        return model.isEmpty() ? "android" : model;
    }

    // ------------------------------------------------------------------ CA / 证书持久化

    public static void setCa(Context context, String caPem, String declaredFingerprint) {
        SharedPreferences.Editor e = prefs(context).edit();
        e.putString(KEY_CA_PEM, caPem == null ? "" : caPem);
        e.putString(KEY_CA_FINGERPRINT, fingerprintOfPem(caPem, declaredFingerprint));
        e.apply();
    }

    public static String caPem(Context context) {
        String pem = prefs(context).getString(KEY_CA_PEM, "");
        return pem == null ? "" : pem;
    }

    public static String caFingerprint(Context context) {
        String fp = prefs(context).getString(KEY_CA_FINGERPRINT, "");
        return fp == null ? "" : fp;
    }

    public static void setBootstrap(Context context, String id, String secret, String expiresAt) {
        prefs(context).edit()
                .putString(KEY_BOOTSTRAP_ID, id == null ? "" : id)
                .putString(KEY_BOOTSTRAP_SECRET, secret == null ? "" : secret)
                .putString(KEY_BOOTSTRAP_EXPIRES_AT, expiresAt == null ? "" : expiresAt)
                .apply();
    }

    public static String bootstrapId(Context context) {
        return prefs(context).getString(KEY_BOOTSTRAP_ID, "");
    }

    public static String bootstrapSecret(Context context) {
        return prefs(context).getString(KEY_BOOTSTRAP_SECRET, "");
    }

    public static String bootstrapExpiresAt(Context context) {
        return prefs(context).getString(KEY_BOOTSTRAP_EXPIRES_AT, "");
    }

    public static boolean hasBootstrap(Context context) {
        String id = bootstrapId(context);
        String secret = bootstrapSecret(context);
        return id != null && !id.isEmpty() && secret != null && !secret.isEmpty();
    }

    /** 引导码成功兑换后立即清除 secret，只保留 bootstrap id 用于同配置去重。 */
    public static void clearBootstrapSecret(Context context) {
        prefs(context).edit().remove(KEY_BOOTSTRAP_SECRET).remove(KEY_BOOTSTRAP_EXPIRES_AT).apply();
    }

    public static void clearBootstrap(Context context) {
        prefs(context).edit().remove(KEY_BOOTSTRAP_ID).remove(KEY_BOOTSTRAP_SECRET)
                .remove(KEY_BOOTSTRAP_EXPIRES_AT).apply();
    }

    public static void setCertificate(Context context, String certPem, String fingerprint, String validTo) {
        String fp = fingerprint;
        if (fp == null || fp.trim().isEmpty()) {
            fp = fingerprintOfPem(certPem, "");
        }
        prefs(context).edit()
                .putString(KEY_CERT_PEM, certPem == null ? "" : certPem)
                .putString(KEY_CERT_FINGERPRINT, fp == null ? "" : fp)
                .putString(KEY_CERT_VALID_TO, validTo == null ? "" : validTo)
                .apply();
    }

    public static String certPem(Context context) {
        String pem = prefs(context).getString(KEY_CERT_PEM, "");
        return pem == null ? "" : pem;
    }

    public static String certFingerprint(Context context) {
        String fp = prefs(context).getString(KEY_CERT_FINGERPRINT, "");
        return fp == null ? "" : fp;
    }

    public static String certValidTo(Context context) {
        String v = prefs(context).getString(KEY_CERT_VALID_TO, "");
        return v == null ? "" : v;
    }

    public static boolean hasCertificate(Context context) {
        return !certPem(context).isEmpty() && hasPrivateKey(context);
    }

    public static String keyStorage(Context context) {
        return prefs(context).getString(KEY_KEY_STORAGE, "");
    }

    public static String keyStorageLabel(Context context) {
        return STORAGE_SOFTWARE.equals(keyStorage(context))
                ? "软件密钥（app 私有目录，未启用系统密钥库）"
                : "AndroidKeyStore（不可导出）";
    }

    // ------------------------------------------------------------------ 密钥

    /** 生成/读取设备密钥的结果。服务器只需要 publicKeyPem。 */
    public static final class KeyMaterial {
        public final PrivateKey privateKey;
        public final String publicKeyPem;
        public final String storage;

        KeyMaterial(PrivateKey privateKey, String publicKeyPem, String storage) {
            this.privateKey = privateKey;
            this.publicKeyPem = publicKeyPem;
            this.storage = storage;
        }
    }

    /**
     * 确保设备密钥存在：优先 AndroidKeyStore EC P-256（用于 mTLS 客户端认证），
     * 不可用时回退软件 EC P-256（PKCS#8 存于 filesDir/phone，仅 app 可读）。
     */
    public static synchronized KeyMaterial ensureKeyMaterial(Context context)
            throws GeneralSecurityException, IOException {
        SharedPreferences p = prefs(context);
        String stored = p.getString(KEY_KEY_STORAGE, "");
        if (!STORAGE_SOFTWARE.equals(stored)) {
            try {
                KeyMaterial km = keystoreMaterial();
                p.edit().putString(KEY_KEY_STORAGE, STORAGE_KEYSTORE)
                        .putString(KEY_PUBLIC_KEY_PEM, km.publicKeyPem).apply();
                return km;
            } catch (Exception e) {
                Log.w(TAG, "AndroidKeyStore 不可用，回退软件密钥：" + e);
                removeKeystoreKeyQuietly();
                p.edit().putString(KEY_KEY_STORAGE, STORAGE_SOFTWARE)
                        .remove(KEY_PUBLIC_KEY_PEM).apply();
            }
        }
        try {
            KeyMaterial km = softwareMaterial(context);
            p.edit().putString(KEY_KEY_STORAGE, STORAGE_SOFTWARE)
                    .putString(KEY_PUBLIC_KEY_PEM, km.publicKeyPem).apply();
            return km;
        } catch (IOException e) {
            throw e;
        } catch (GeneralSecurityException e) {
            throw e;
        } catch (Exception e) {
            throw new GeneralSecurityException("软件设备密钥准备失败：" + e, e);
        }
    }

    public static String publicKeyPem(Context context) throws GeneralSecurityException, IOException {
        String stored = prefs(context).getString(KEY_PUBLIC_KEY_PEM, "");
        if (stored != null && !stored.trim().isEmpty()) {
            return stored;
        }
        return ensureKeyMaterial(context).publicKeyPem;
    }

    private static KeyMaterial keystoreMaterial() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.PrivateKeyEntry) {
                KeyStore.PrivateKeyEntry pk = (KeyStore.PrivateKeyEntry) entry;
                probeSign(pk.getPrivateKey());
                // TLS 1.3 的 CertificateVerify 由 Conscrypt 用 NONEwithECDSA（原始摘要）签名，
                // 旧版本密钥若未授权 DIGEST_NONE 会得到 INCOMPATIBLE_DIGEST，这里探测到就重建密钥。
                probeRawSign(pk.getPrivateKey());
                PublicKey pub = pk.getCertificate() == null ? null : pk.getCertificate().getPublicKey();
                if (pub != null) {
                    return new KeyMaterial(pk.getPrivateKey(), encodePublicKeyPem(pub), STORAGE_KEYSTORE);
                }
            }
            removeKeystoreKeyQuietly();
        }
        KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                // DIGEST_NONE 必须授权：Conscrypt 在 TLS 1.3 客户端证书签名时用 NONEwithECDSA（原始摘要）。
                .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256,
                        KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                .setUserAuthenticationRequired(false)
                .build();
        kpg.initialize(spec);
        KeyPair kp = kpg.generateKeyPair();
        probeSign(kp.getPrivate());
        return new KeyMaterial(kp.getPrivate(), encodePublicKeyPem(kp.getPublic()), STORAGE_KEYSTORE);
    }

    private static KeyMaterial softwareMaterial(Context context) throws Exception {
        File dir = softwareDir(context);
        File file = new File(dir, SOFTWARE_KEY_FILE);
        String storedPem = prefs(context).getString(KEY_PUBLIC_KEY_PEM, "");
        if (file.isFile() && file.length() > 0 && storedPem != null && !storedPem.trim().isEmpty()) {
            byte[] der = readBytes(file);
            PrivateKey key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
            probeSign(key);
            return new KeyMaterial(key, storedPem, STORAGE_SOFTWARE);
        }
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"), new SecureRandom());
        KeyPair kp = kpg.generateKeyPair();
        byte[] der = kp.getPrivate().getEncoded();
        if (der == null || der.length == 0) {
            throw new GeneralSecurityException("软件设备密钥无法导出 PKCS#8");
        }
        writePrivateBytes(new File(dir, SOFTWARE_KEY_FILE), der);
        return new KeyMaterial(kp.getPrivate(), encodePublicKeyPem(kp.getPublic()), STORAGE_SOFTWARE);
    }

    private static void probeSign(PrivateKey key) throws Exception {
        Signature sig = Signature.getInstance("SHA256withECDSA");
        sig.initSign(key);
        sig.update("dshlink-phone-key-probe".getBytes(StandardCharsets.UTF_8));
        sig.sign();
    }

    /** 探测密钥是否支持 Conscrypt TLS 1.3 客户端认证所需的原始摘要签名（NONEwithECDSA）。 */
    private static void probeRawSign(PrivateKey key) throws Exception {
        Signature sig = Signature.getInstance("NONEwithECDSA");
        sig.initSign(key);
        sig.update(new byte[32]);
        sig.sign();
    }

    public static PrivateKey loadPrivateKey(Context context) throws GeneralSecurityException, IOException {
        String storage = prefs(context).getString(KEY_KEY_STORAGE, "");
        if (STORAGE_SOFTWARE.equals(storage)) {
            File file = new File(softwareDir(context), SOFTWARE_KEY_FILE);
            if (!file.isFile()) {
                throw new GeneralSecurityException("软件设备私钥文件不存在（files/phone/" + SOFTWARE_KEY_FILE + "）");
            }
            byte[] der = readBytes(file);
            return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
        }
        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.PrivateKeyEntry) {
                return ((KeyStore.PrivateKeyEntry) entry).getPrivateKey();
            }
        } catch (Exception e) {
            throw new GeneralSecurityException("读取 AndroidKeyStore 设备私钥失败：" + e.getMessage(), e);
        }
        throw new GeneralSecurityException("AndroidKeyStore 中没有设备私钥（" + KEY_ALIAS + "）");
    }

    private static boolean hasPrivateKey(Context context) {
        String storage = prefs(context).getString(KEY_KEY_STORAGE, "");
        if (STORAGE_SOFTWARE.equals(storage)) {
            return new File(softwareDir(context), SOFTWARE_KEY_FILE).isFile();
        }
        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            return ks.containsAlias(KEY_ALIAS);
        } catch (Exception e) {
            return false;
        }
    }

    private static File softwareDir(Context context) {
        File dir = new File(context.getApplicationContext().getFilesDir(), SOFTWARE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            Log.w(TAG, "无法创建软件密钥目录：" + dir);
        }
        return dir;
    }

    private static void removeKeystoreKeyQuietly() {
        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) {
                ks.deleteEntry(KEY_ALIAS);
            }
        } catch (Exception e) {
            Log.w(TAG, "删除 AndroidKeyStore 密钥失败：" + e);
        }
    }

    // ------------------------------------------------------------------ 重置 / 失效

    /**
     * 清除本机设备证书与私钥。
     *
     * @param alsoDeviceIdentity true 时同时清除 deviceId（下次引导会换成新设备身份）
     */
    public static void resetCertificate(Context context, boolean alsoDeviceIdentity) {
        SharedPreferences.Editor e = prefs(context).edit();
        e.remove(KEY_CERT_PEM).remove(KEY_CERT_FINGERPRINT).remove(KEY_CERT_VALID_TO)
                .remove(KEY_PUBLIC_KEY_PEM).remove(KEY_KEY_STORAGE);
        if (alsoDeviceIdentity) {
            e.remove(KEY_DEVICE_ID);
        }
        e.apply();
        removeKeystoreKeyQuietly();
        deleteQuietly(new File(softwareDir(context), SOFTWARE_KEY_FILE));
        Log.i(TAG, "设备证书已清除（alsoDeviceIdentity=" + alsoDeviceIdentity + "）");
    }

    /** 服务器报告证书被吊销/未知时调用：清掉证书，保留 CA 与 deviceId。 */
    public static void invalidateCertificate(Context context) {
        resetCertificate(context, false);
    }

    /** 清除整个 dshlink2 安全配置（CA、一次性引导码、证书、私钥），保留 deviceId。 */
    public static void clearProfileSecurity(Context context) {
        SharedPreferences.Editor e = prefs(context).edit();
        e.remove(KEY_SECURE_MODE).remove(KEY_CA_PEM).remove(KEY_CA_FINGERPRINT)
                .remove(KEY_CERT_PEM).remove(KEY_CERT_FINGERPRINT).remove(KEY_CERT_VALID_TO)
                .remove(KEY_PUBLIC_KEY_PEM).remove(KEY_KEY_STORAGE)
                .remove(KEY_BOOTSTRAP_ID).remove(KEY_BOOTSTRAP_SECRET)
                .remove(KEY_BOOTSTRAP_EXPIRES_AT);
        e.apply();
        removeKeystoreKeyQuietly();
        deleteQuietly(new File(softwareDir(context), SOFTWARE_KEY_FILE));
    }

    /** 容忍本机时钟与 CA 签发时刻之间的少量偏差：刚签发的证书 notBefore 可能比手机时间晚几秒。 */
    private static final long CLOCK_SKEW_MS = 2 * 60 * 1000L;

    private static void checkValidityWithSkew(X509Certificate cert)
            throws CertificateExpiredException, CertificateNotYetValidException {
        long now = System.currentTimeMillis();
        if (cert.getNotAfter().getTime() + CLOCK_SKEW_MS < now) {
            throw new CertificateExpiredException(cert.getNotAfter().toString());
        }
        if (cert.getNotBefore().getTime() > now + CLOCK_SKEW_MS) {
            throw new CertificateNotYetValidException(cert.getNotBefore().toString());
        }
    }

    // ------------------------------------------------------------------ mTLS 上下文

    /** 引导（尚未有设备证书）时用：只信任导入的 CA，不带客户端证书。 */
    public static SSLContext bootstrapContext(String caPem) throws GeneralSecurityException {
        X509Certificate ca = parseCertificate(caPem);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(new KeyManager[0], new TrustManager[]{new PinnedCaTrustManager(ca)}, new SecureRandom());
        return ctx;
    }

    /** 已有设备证书时用：客户端证书 + 只信任导入的 CA。 */
    public static SSLContext mutualTlsContext(Context context) throws GeneralSecurityException {
        String caPem = caPem(context);
        if (caPem.isEmpty()) {
            throw new GeneralSecurityException("还没有导入 CA 证书，请重新导入 dshlink2 安全连接串");
        }
        String certPem = certPem(context);
        if (certPem.isEmpty()) {
            throw new GeneralSecurityException("本机还没有设备证书，请先完成一次性引导");
        }
        X509Certificate ca = parseCertificate(caPem);
        X509Certificate leaf = parseCertificate(certPem);
        try {
            checkValidityWithSkew(leaf);
        } catch (CertificateExpiredException ex) {
            throw new GeneralSecurityException("设备证书已于 " + leaf.getNotAfter() + " 到期，请让管理员重新签发引导码并重新导入");
        } catch (CertificateNotYetValidException ex) {
            throw new GeneralSecurityException("设备证书尚未生效（" + leaf.getNotBefore() + "），请确认手机时间正确");
        }
        PrivateKey key;
        try {
            key = loadPrivateKey(context);
        } catch (IOException ex) {
            throw new GeneralSecurityException("读取设备私钥失败：" + ex.getMessage(), ex);
        }
        X509Certificate[] chain = new X509Certificate[]{leaf};
        StaticClientKeyManager km = new StaticClientKeyManager(key, chain);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(new KeyManager[]{km}, new TrustManager[]{new PinnedCaTrustManager(ca)}, new SecureRandom());
        return ctx;
    }

    /** 只信任连接串里 CA 的服务器证书校验器（会校验有效期、签名链与 serverAuth 用途）。 */
    static final class PinnedCaTrustManager implements X509TrustManager {
        private final X509Certificate ca;

        PinnedCaTrustManager(X509Certificate ca) {
            this.ca = ca;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("本端不校验客户端证书");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) {
                throw new CertificateException("服务器没有提供 TLS 证书");
            }
            X509Certificate leaf = chain[0];
            try {
                checkValidityWithSkew(leaf);
            } catch (CertificateExpiredException e) {
                throw new CertificateException("服务器证书已过期：" + e.getMessage());
            } catch (CertificateNotYetValidException e) {
                throw new CertificateException("服务器证书尚未生效：" + e.getMessage());
            }
            X509Certificate cur = leaf;
            int guard = 0;
            boolean reachedCa = false;
            while (guard++ < 6) {
                if (cur.equals(ca)) {
                    reachedCa = true;
                    break;
                }
                X509Certificate issuer = null;
                if (ca.getSubjectX500Principal().equals(cur.getIssuerX500Principal())) {
                    issuer = ca;
                } else {
                    for (int i = 1; i < chain.length; i++) {
                        if (chain[i].getSubjectX500Principal().equals(cur.getIssuerX500Principal())) {
                            issuer = chain[i];
                            break;
                        }
                    }
                }
                if (issuer == null) {
                    throw new CertificateException("服务器证书链没有落到导入的 CA（该服务器可能不是连接串对应的 hub）");
                }
                try {
                    cur.verify(issuer.getPublicKey());
                } catch (Exception e) {
                    throw new CertificateException("服务器证书签名校验失败：" + e.getMessage());
                }
                cur = issuer;
            }
            if (!reachedCa) {
                throw new CertificateException("服务器证书链没有落到导入的 CA（链过长或已断开）");
            }
            try {
                java.util.List<String> eku = leaf.getExtendedKeyUsage();
                if (eku != null && !eku.contains(SERVER_AUTH_EKU)) {
                    throw new CertificateException("服务器证书用途不是 TLS 服务器认证");
                }
            } catch (CertificateParsingException e) {
                // 无法解析 EKU 时依赖签名链验证即可
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[]{ca};
        }
    }

    /** 固定返回服务器签发的设备证书链与本地私钥的客户端 KeyManager。 */
    static final class StaticClientKeyManager extends X509ExtendedKeyManager {
        private static final String ALIAS = "dshlink-device-cert";
        private final PrivateKey privateKey;
        private final X509Certificate[] chain;

        StaticClientKeyManager(PrivateKey privateKey, X509Certificate[] chain) {
            this.privateKey = privateKey;
            this.chain = chain == null ? new X509Certificate[0] : chain.clone();
        }

        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return new String[]{ALIAS};
        }

        @Override
        public String chooseClientAlias(String[] keyTypes, Principal[] issuers, Socket socket) {
            return ALIAS;
        }

        @Override
        public String chooseEngineClientAlias(String[] keyTypes, Principal[] issuers, SSLEngine engine) {
            return ALIAS;
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return null;
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return null;
        }

        @Override
        public String chooseEngineServerAlias(String keyType, Principal[] issuers, SSLEngine engine) {
            return null;
        }

        @Override
        public X509Certificate[] getCertificateChain(String alias) {
            return ALIAS.equals(alias) ? chain.clone() : null;
        }

        @Override
        public PrivateKey getPrivateKey(String alias) {
            return ALIAS.equals(alias) ? privateKey : null;
        }
    }

    // ------------------------------------------------------------------ PEM / 指纹工具

    public static String encodePem(String type, byte[] der) {
        String base64 = Base64.encodeToString(der, Base64.NO_WRAP);
        StringBuilder sb = new StringBuilder();
        sb.append("-----BEGIN ").append(type).append("-----\n");
        for (int i = 0; i < base64.length(); i += 64) {
            sb.append(base64, i, Math.min(i + 64, base64.length())).append('\n');
        }
        sb.append("-----END ").append(type).append("-----\n");
        return sb.toString();
    }

    public static String encodePublicKeyPem(PublicKey key) {
        byte[] der = key.getEncoded();
        if (der == null || der.length == 0) {
            return "";
        }
        return encodePem("PUBLIC KEY", der);
    }

    public static byte[] pemToDer(String pem) {
        if (pem == null) {
            return new byte[0];
        }
        // Line-based PEM body extraction: avoid regex character-class pitfalls around "-----".
        StringBuilder body = new StringBuilder();
        for (String line : pem.split("\r?\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("-----")) {
                continue;
            }
            body.append(trimmed);
        }
        if (body.length() == 0) {
            return new byte[0];
        }
        try {
            return Base64.decode(body.toString(), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return new byte[0];
        }
    }

    public static X509Certificate parseCertificate(String pem) throws GeneralSecurityException {
        byte[] der = pemToDer(pem);
        if (der.length == 0) {
            throw new GeneralSecurityException("证书内容为空");
        }
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            return (X509Certificate) factory.generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception e) {
            throw new GeneralSecurityException("证书解析失败：" + e.getMessage(), e);
        }
    }

    /** 计算证书 DER 的 SHA-256 指纹（大写十六进制、冒号分隔，与 Node fingerprint256 一致）。 */
    public static String fingerprintOfPem(String pem, String fallback) {
        try {
            byte[] der = pemToDer(pem);
            if (der.length == 0) {
                return fallback == null ? "" : fallback;
            }
            return fingerprint(der);
        } catch (Exception e) {
            return fallback == null ? "" : fallback;
        }
    }

    public static String fingerprint(byte[] der) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(der);
            StringBuilder sb = new StringBuilder();
            for (byte b : hashed) {
                if (sb.length() > 0) {
                    sb.append(':');
                }
                sb.append(String.format(Locale.US, "%02X", b & 0xFF));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 比较两个指纹是否相同（忽略大小写与冒号/空格差异）。 */
    public static boolean sameFingerprint(String a, String b) {
        String na = normalizeFingerprint(a);
        String nb = normalizeFingerprint(b);
        return !na.isEmpty() && na.equals(nb);
    }

    public static String normalizeFingerprint(String value) {
        if (value == null) {
            return "";
        }
        return value.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.US);
    }

    // ------------------------------------------------------------------ IO 小工具

    private static byte[] readBytes(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[(int) Math.min(file.length(), 1 << 20)];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) {
                    break;
                }
                off += n;
            }
            byte[] out = new byte[off];
            System.arraycopy(buf, 0, out, 0, off);
            return out;
        }
    }

    private static void writePrivateBytes(File file, byte[] data) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建目录：" + dir);
        }
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
            out.getFD().sync();
        }
        // 尽力限制为仅本 app 用户可读（Android 10+ 上 files 目录本来就属 app 沙箱）。
        //noinspection ResultOfMethodCallIgnored
        file.setReadable(false, false);
        //noinspection ResultOfMethodCallIgnored
        file.setReadable(true, true);
        //noinspection ResultOfMethodCallIgnored
        file.setWritable(false, false);
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "删除文件失败：" + file);
        }
    }
}
