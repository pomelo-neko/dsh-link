package dev.dshlink.control;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Insets;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class Ui {
    private Ui() {
    }

    /**
     * Reads a JSON string without turning JSON null into the literal text "null" (Android's
     * optString returns "null" for JSONObject.NULL when a fallback is supplied).
     */
    static String text(JSONObject object, String key) {
        if (object == null) return "";
        Object value = object.opt(key);
        if (value == null || JSONObject.NULL.equals(value)) return "";
        return String.valueOf(value);
    }

    static int dp(Context context, int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                context.getResources().getDisplayMetrics()));
    }

    /**
     * Android 15+ (API 35) enforces edge-to-edge for apps targeting SDK 35+, so the framework
     * ActionBar is drawn on top of the content instead of inset above it. Pad the content root by
     * the status bar + action bar heights so the first rows are not hidden, and (optionally) keep
     * the bottom content above the IME.
     *
     * On older systems the window decor still handles this, so this is a no-op there.
     */
    static void applyEdgeToEdgePadding(Activity activity, boolean imeAware) {
        if (Build.VERSION.SDK_INT < 35) return;
        View content = activity.findViewById(android.R.id.content);
        if (!(content instanceof ViewGroup) || ((ViewGroup) content).getChildCount() == 0) return;
        ViewGroup root = (ViewGroup) ((ViewGroup) content).getChildAt(0);
        final int baseLeft = root.getPaddingLeft();
        final int baseTop = root.getPaddingTop();
        final int baseRight = root.getPaddingRight();
        final int baseBottom = root.getPaddingBottom();
        TypedValue size = new TypedValue();
        int actionBar = 0;
        if (activity.getTheme().resolveAttribute(android.R.attr.actionBarSize, size, true)) {
            actionBar = TypedValue.complexToDimensionPixelSize(size.data,
                    activity.getResources().getDisplayMetrics());
        }
        final int actionBarPx = actionBar;
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                int bottom = bars.bottom;
                if (imeAware) {
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    if (ime.bottom > bottom) bottom = ime.bottom;
                }
                view.setPadding(baseLeft, baseTop + bars.top + actionBarPx, baseRight,
                        baseBottom + bottom);
                return insets;
            }
        });
        root.requestApplyInsets();
    }

    static String clock(long epochMillis) {
        if (epochMillis <= 0) return "";
        SimpleDateFormat format = new SimpleDateFormat("HH:mm:ss", Locale.US);
        return format.format(new Date(epochMillis));
    }

    static String shortIso(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US);
            parser.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date date = parser.parse(iso);
            if (date == null) return iso.length() > 16 ? iso.substring(5, 16).replace('T', ' ') : iso;
            SimpleDateFormat out = new SimpleDateFormat("MM-dd HH:mm", Locale.US);
            return out.format(date);
        } catch (Exception err) {
            return iso.length() > 16 ? iso.substring(5, 16).replace('T', ' ') : iso;
        }
    }

    static boolean contains(JSONArray array, String value) {
        if (array == null) return false;
        for (int i = 0; i < array.length(); i++) {
            if (value.equals(array.optString(i))) return true;
        }
        return false;
    }

    static void toast(Context context, String message) {
        Toast.makeText(context, message, Toast.LENGTH_LONG).show();
    }

    /** Human explanation for the most common node errors, including what to change where. */
    static String describe(ApiException err) {
        if (err == null) return "未知错误";
        String phone = describePhone(err);
        if (phone != null) return phone;
        if (err.isNetworkError()) {
            return err.getMessage() + "\n\n检查：手机和节点是否在同一网络（推荐 WireGuard/Tailscale）；"
                    + "节点 bind/端口是否正确；地址是否需要 http://。";
        }
        if (err.status == 401) {
            return "鉴权失败：token 无效或已过期。\n"
                    + "0.5+ 节点：在节点执行 dshlink token new --role device --label phone；"
                    + "hub：在 hub 执行 dshlink hub token new --role device --label phone。"
                    + "把打印的明文填到本页（hub 从不信任 localhost，必须带 token）。";
        }
        if (err.status == 403) {
            if ("role_forbidden".equals(err.code)) {
                return "权限不足：这个 token 的角色不允许访问该接口。\n"
                        + "读取 DSH 需要 device/peer/admin；发送命令需要 device/admin；"
                        + "bridge 控制面只有 bridge token 或本机可用。"
                        + "hub 模式下 token 由中心服务器校验，节点侧的 dsh / capabilities 权限仍然生效。";
            }
            if ("capability_denied".equals(err.code)) {
                return "节点拒绝了这条命令（" + err.getMessage() + "）。\n\n"
                        + "在节点 config.json 里设置 capabilities.enabled = true，"
                        + "并把 sessions.prompt 加进 capabilities.methods；"
                        + "同时确认 DSH 内的 dsh-link bridge 插件在运行（它负责真正把 prompt 交给 DSH）。";
            }
            return "权限不足（" + err.code + "）：" + err.getMessage();
        }
        if (err.status == 404) {
            return "接口或对象不存在（404）：节点可能低于 0.5.0、该 DSH 会话已被删除，"
                    + "或中心服务器上没有登记这个节点（unknown_target）。\n" + err.getMessage();
        }
        if (err.status == 502) {
            return "中心服务器连不上目标节点（502 upstream_unreachable）：节点离线、"
                    + "节点 url 或 heartbeat 失效，或节点到 hub 的网络中断。\n" + err.getMessage();
        }
        if (err.status == 504) {
            return "等待节点响应超时（504）：节点可能卡住或网络抖动，稍后重试。\n" + err.getMessage();
        }
        if (err.status == 429) {
            return "请求被节点限速（429）。稍等一会儿再试；节点限制见 limits.maxRequestsPerMinute。";
        }
        if (err.status == 503) {
            return "节点暂时不可用（503）：" + err.getMessage()
                    + "\n检查节点的 dsh.enabled / dsh.home，以及 DSH host 是否在运行。";
        }
        return err.getMessage() + (err.code.isEmpty() ? "" : "（" + err.code + "）");
    }

    /**
     * 0.6.0 手机安全相关错误：dshlink2 一次性引导、每设备证书 mTLS、hub 手机网关。
     * 返回 null 表示不是这些错误，交给原有分支处理。
     */
    static String describePhone(ApiException err) {
        if (err == null) return null;
        String code = err.code == null ? "" : err.code;
        if ("tls_error".equals(code)) {
            return "TLS 握手失败：无法与服务器建立受信任的加密连接。\n\n"
                    + "检查：1) 手机系统时间是否正确（证书有效期依赖它）；"
                    + "2) 导入的 dshlink2 连接串是否来自当前这台 hub（CA 是否已更换）；"
                    + "3) 证书模式下设备证书是否已被重置/吊销——请重新导入管理员签发的引导码，或用“重置设备证书”。\n"
                    + err.getMessage();
        }
        if ("no_certificate".equals(code) || "no_profile".equals(code)) {
            return "本机还没有可用的设备证书：" + err.getMessage()
                    + "\n\n请让 hub 管理员执行 dshlink hub phone bootstrap 生成新的 dshlink2 引导码，并重新导入连接串。";
        }
        if ("cert_setup".equals(code) || "key_error".equals(code)) {
            return "设备证书准备失败：" + err.getMessage();
        }
        switch (code) {
            case "bootstrap_rejected":
                return "一次性引导码被拒绝（bootstrap_rejected）：引导码可能已被使用、已过期，或与当前 hub 不匹配。\n" + err.getMessage()
                        + "\n\n请让管理员重新生成 dshlink2 引导码并重新导入连接串。";
            case "phone_bootstrap_expired":
                return "一次性引导码已过期（phone_bootstrap_expired）。\n" + err.getMessage()
                        + "\n\n请让管理员重新生成引导码（默认有效期 2 小时）并重新导入连接串。";
            case "phone_revoked":
                return "本机设备证书已被 hub 管理员吊销（phone_revoked），本机证书已自动清除。\n" + err.getMessage()
                        + "\n\n请让管理员重新签发 dshlink2 引导码；拿到新连接串后重新导入即可。";
            case "phone_enrollment_closed":
                return "hub 当前关闭了手机注册（phone_enrollment_closed）。\n" + err.getMessage()
                        + "\n\n请管理员在 hub 配置里允许注册新设备（phoneGateway.allowNewDevices）。";
            case "phone_gateway_disabled":
                return "hub 的手机网关未启用（phone_gateway_disabled）。\n" + err.getMessage()
                        + "\n\n请管理员在 hub 上运行 dshlink hub phone setup 并重启 hub serve。";
            case "phone_certificate_invalid":
                return "设备证书未通过 hub 校验（phone_certificate_invalid）：可能已过期、被替换，或不是当前 CA 签发。\n"
                        + "本机证书已自动清除。\n" + err.getMessage()
                        + "\n\n请管理员重新签发引导码后重新导入连接串。";
            case "phone_unknown":
                return "hub 不认识这张设备证书（phone_unknown）：设备记录可能已被删除。本机证书已自动清除。\n"
                        + err.getMessage() + "\n\n请管理员重新签发引导码后重新导入连接串。";
            case "client_certificate_required":
                return "服务器要求客户端证书（client_certificate_required），但本机没有发送设备证书。\n"
                        + "本机证书状态可能已损坏，请用“重置设备证书”后重新导入 dshlink2 引导码。";
            case "phone_route_denied":
                return "hub 的手机网关不允许访问该接口（phone_route_denied）。\n" + err.getMessage()
                        + "\n\n手机端只开放 /api/v1/info、/api/v1/network/*、/api/v1/dsh/*。";
            case "too_many_devices":
                return "hub 已达到最大注册设备数（too_many_devices）。\n" + err.getMessage()
                        + "\n\n请在 hub 上运行 dshlink hub phone devices 清理旧设备，或调大 maxDevices。";
            case "too_many_attempts":
                return "引导尝试过于频繁（too_many_attempts），已被 hub 临时限速。请等待 1 分钟再重新导入。";
            case "bad_public_key":
                return "hub 无法使用手机提交的公钥（bad_public_key）。\n" + err.getMessage()
                        + "\n\n请用“重置设备证书”重新生成密钥后重试。";
            case "phone_gateway_timeout":
                return "hub 转发到节点超时（phone_gateway_timeout）。节点可能卡住或离线，稍后重试。";
            case "tls_required":
                return "hub 要求 https 连接（tls_required）。dshlink2 连接串的入口地址必须是 https://…";
            case "phone_ca_unavailable":
                return "hub 的手机 CA 不可用（phone_ca_unavailable）。请管理员在 hub 上重新执行 dshlink hub phone setup。";
            case "payload_too_large":
                return "引导请求过大（payload_too_large）。请重新导入连接串，或联系管理员排查客户端版本。";
            default:
                return null;
        }
    }

    static void showError(Activity activity, ApiException err) {
        boolean certInvalidated = false;
        if (err != null) {
            String code = err.code == null ? "" : err.code;
            if ("phone_revoked".equals(code) || "phone_unknown".equals(code)
                    || "phone_certificate_invalid".equals(code)
                    || "client_certificate_required".equals(code)) {
                PhoneIdentity.invalidateCertificate(activity);
                certInvalidated = true;
            }
        }
        String message = describe(err);
        if (certInvalidated) {
            message += "\n\n（本机设备证书已清除；请重新导入管理员签发的 dshlink2 引导码，或点“重置设备证书”。）";
        }
        new AlertDialog.Builder(activity)
                .setTitle("请求失败")
                .setMessage(message)
                .setPositiveButton("知道了", null)
                .show();
    }

    static String workspaceLabel(JSONObject workspace) {
        if (workspace == null) return "工作区";
        String title = workspace.optString("title", "");
        if (title.isEmpty()) title = workspace.optString("id", "工作区");
        return title;
    }

    static String sessionTitle(JSONObject session) {
        if (session == null) return "会话";
        String title = session.optString("title", "");
        if (title.isEmpty()) title = session.optString("sessionId", "会话");
        return title;
    }
}
