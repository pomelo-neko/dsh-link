package dev.dshlink.control;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * Process-wide view of the dsh-link network the app controls.
 *
 * The app always talks to one gateway node. That node can relay DSH view calls to a directly
 * configured peer with the "peer" query/body parameter, so selecting a peer here only changes the
 * parameter, never the HTTP endpoint. Nodes that are two hops away are discoverable but not
 * directly controllable yet; the network scan marks them with a non-empty "via" list.
 */
final class NodeState {
    static ApiClient client;
    static JSONObject info;
    static JSONObject network;
    static JSONArray nodes = new JSONArray();
    static JSONObject selectedNode;
    /** Empty for the gateway node itself, otherwise a direct peer name. */
    static String selectedPeer = "";
    static String baseUrl = "";
    static String token = "";

    private NodeState() {
    }

    static void reset() {
        client = null;
        info = null;
        network = null;
        nodes = new JSONArray();
        selectedNode = null;
        selectedPeer = "";
        baseUrl = "";
        token = "";
    }

    static boolean isRemote() {
        return selectedPeer != null && !selectedPeer.isEmpty();
    }

    static String nodeLabel() {
        if (selectedNode != null) {
            String name = selectedNode.optString("name", "");
            if (!name.isEmpty()) return name;
        }
        if (info != null) {
            String name = info.optString("name", "");
            if (!name.isEmpty()) return name;
        }
        return baseUrl;
    }

    static String nodeVersion() {
        String version = "";
        if (selectedNode != null) version = selectedNode.optString("softwareVersion", "");
        if (version.isEmpty() && info != null) {
            version = info.optString("softwareVersion", info.optString("version", "?"));
        }
        return version.isEmpty() ? "?" : version;
    }

    static JSONObject capabilities() {
        if (selectedNode != null) {
            JSONObject caps = selectedNode.optJSONObject("capabilities");
            if (caps != null) return caps;
        }
        return info == null ? null : info.optJSONObject("capabilities");
    }

    static boolean canView() {
        if (selectedNode != null) {
            JSONObject dsh = selectedNode.optJSONObject("dsh");
            return dsh != null && dsh.optBoolean("workspaces", false);
        }
        JSONObject dsh = info == null ? null : info.optJSONObject("dsh");
        return dsh != null && dsh.optBoolean("workspaces", false);
    }

    /** True only when the selected node reports capabilities enabled and sessions.prompt. */
    static boolean canSend() {
        JSONObject caps = capabilities();
        return caps != null
                && caps.optBoolean("enabled", false)
                && Ui.contains(caps.optJSONArray("methods"), "sessions.prompt");
    }

    /** Append the selected peer to a DSH view path; the gateway node relays it. */
    static String dshPath(String path) {
        if (!isRemote()) return path;
        char separator = path.indexOf('?') >= 0 ? '&' : '?';
        return path + separator + "peer=" + enc(selectedPeer);
    }

    private static String enc(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException err) {
            return value;
        }
    }
}
