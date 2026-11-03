package dev.dshlink.control;

import org.json.JSONObject;

/** Process-wide connection to the one node the app is currently controlling. */
final class NodeState {
    static ApiClient client;
    static JSONObject info;
    static String baseUrl = "";
    static String token = "";

    private NodeState() {
    }

    static void reset() {
        client = null;
        info = null;
        baseUrl = "";
        token = "";
    }

    /** True only when the node reports capabilities enabled and sessions.prompt among the methods. */
    static boolean canSend() {
        JSONObject caps = info == null ? null : info.optJSONObject("capabilities");
        return caps != null
                && caps.optBoolean("enabled", false)
                && Ui.contains(caps.optJSONArray("methods"), "sessions.prompt");
    }
}
