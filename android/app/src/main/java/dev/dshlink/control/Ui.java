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
        if (err.isNetworkError()) {
            return err.getMessage() + "\n\n检查：手机和节点是否在同一网络（推荐 WireGuard/Tailscale）；"
                    + "节点 bind/端口是否正确；地址是否需要 http://。";
        }
        if (err.status == 401) {
            return "鉴权失败：token 无效或已过期。\n"
                    + "0.5+ 节点每个请求都要 token：在节点执行 dshlink token new --role device --label phone，"
                    + "把打印的明文填到本页。";
        }
        if (err.status == 403) {
            if ("role_forbidden".equals(err.code)) {
                return "权限不足：这个 token 的角色不允许访问该接口。\n"
                        + "读取 DSH 需要 device/peer/admin；发送命令需要 device/admin；"
                        + "bridge 控制面只有 bridge token 或本机可用。";
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
            return "接口不存在（404）：节点可能低于 0.5.0，或该 DSH 会话已被删除。\n" + err.getMessage();
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

    static void showError(Activity activity, ApiException err) {
        new AlertDialog.Builder(activity)
                .setTitle("请求失败")
                .setMessage(describe(err))
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
