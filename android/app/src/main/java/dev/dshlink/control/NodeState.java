package dev.dshlink.control;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * Process-wide connection state.
 *
 * 0.4.0 talks to one gateway at a time, and the gateway can be either:
 *
 *  - a dsh-link node (0.7+). /api/v1/network/nodes discovers its network; selecting a direct peer
 *    only changes the "peer" parameter of the DSH view calls, never the HTTP endpoint itself.
 *  - a hub (0.8+). The hub keeps an enrollment table of nodes and proxies every DSH view/call to
 *    the node named by "peer"; without a peer the hub falls back to its default node. Hub mode
 *    therefore always sends a peer, and MainActivity never lets the screen read a node silently.
 *
 * Only one of the two modes is active; MainActivity resets this singleton for every connection.
 */
final class NodeState {
    static ApiClient client;
    static JSONObject info;
    static JSONObject network;
    static JSONArray nodes = new JSONArray();
    static JSONObject selectedNode;
    /** Empty for the gateway node itself, otherwise the node name used as "peer". */
    static String selectedPeer = "";
    static String baseUrl = "";
    static String token = "";
    /** True when the gateway is a hub; detected from GET /api/v1/info. */
    static boolean hubMode;

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
        hubMode = false;
    }

    static boolean isHub() {
        return hubMode;
    }

    static boolean isRemote() {
        return selectedPeer != null && !selectedPeer.isEmpty();
    }

    static String hubName() {
        return info == null ? "" : Ui.text(info, "name");
    }

    static String hubVersion() {
        if (info == null) return "?";
        String version = Ui.text(info, "softwareVersion");
        if (version.isEmpty()) version = Ui.text(info, "version");
        return version.isEmpty() ? "?" : version;
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

    /** Append the selected peer to a DSH view path; node and hub gateways both accept "peer". */
    static String dshPath(String path) {
        if (!isRemote()) return path;
        return peerPath(path, selectedPeer);
    }

    /** Explicitly append a node name to a hub/admin path (used while connecting, before state is set). */
    static String peerPath(String path, String peer) {
        if (peer == null || peer.isEmpty()) return path;
        char separator = path.indexOf('?') >= 0 ? '&' : '?';
        return path + separator + "peer=" + enc(peer);
    }

    /** Poll a command result through the same gateway that accepted it. */
    static String callResultPath(String commandId) {
        String path = "/api/v1/dsh/call/" + enc(commandId);
        return isRemote() ? peerPath(path, selectedPeer) : path;
    }

    /** A hub is identified by role=hub, its software name, or the enrollment table in info. */
    static boolean detectHub(JSONObject info) {
        if (info == null) return false;
        if ("hub".equals(Ui.text(info, "role"))) return true;
        if ("dsh-link-hub".equals(Ui.text(info, "software"))) return true;
        return info.has("nodes") && info.optJSONArray("nodes") != null;
    }

    private static String enc(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException err) {
            return value;
        }
    }
}
