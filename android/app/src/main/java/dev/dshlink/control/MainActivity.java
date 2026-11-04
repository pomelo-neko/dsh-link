package dev.dshlink.control;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Connect to a dsh-link hub (0.8+) or to a single dsh-link node (0.7) and browse the DSH
 * workspaces of the nodes it knows.
 *
 * The gateway kind is detected from GET /api/v1/info: a hub answers with role="hub" plus its
 * enrollment table (nodes[]); a node answers with its own dsh/capabilities view. In hub mode the
 * selected node name travels as the "peer" parameter and the hub proxies every DSH call to it, so
 * the screen always shows which node it is reading. Nothing is polled here: data is fetched on
 * connect or on an explicit refresh.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "dshlink";
    private static final String KEY_URL = "url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_TUNNEL = "tunnel";

    private EditText urlInput;
    private EditText tokenInput;
    private CheckBox tunnelCheck;
    private Spinner nodeSpinner;
    private Button connectButton;
    private Button refreshButton;
    private TextView statusView;
    private TextView summaryView;
    private TextView warningView;
    private TextView emptyView;
    private ListView listView;
    private WorkspaceAdapter adapter;
    private ArrayAdapter<String> nodeAdapter;
    private final List<JSONObject> networkNodes = new ArrayList<>();
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean hubMode;
    private boolean canSend;
    private boolean applyingNodes;
    private int lastDirectIndex;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        Ui.applyEdgeToEdgePadding(this, false);
        urlInput = findViewById(R.id.url_input);
        tokenInput = findViewById(R.id.token_input);
        tunnelCheck = findViewById(R.id.tunnel_check);
        nodeSpinner = findViewById(R.id.node_spinner);
        connectButton = findViewById(R.id.connect_button);
        refreshButton = findViewById(R.id.refresh_button);
        statusView = findViewById(R.id.status);
        summaryView = findViewById(R.id.summary);
        warningView = findViewById(R.id.warning);
        emptyView = findViewById(R.id.empty);
        listView = findViewById(R.id.workspace_list);
        adapter = new WorkspaceAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(emptyView);

        nodeAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item,
                new ArrayList<String>());
        nodeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        nodeSpinner.setAdapter(nodeAdapter);
        nodeSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (applyingNodes) return;
                // Android can deliver a deferred onItemSelected for the selection we just made
                // ourselves; selecting the already-selected node would duplicate the fetch (and
                // surface errors twice), so ignore it.
                if (position >= 0 && position < networkNodes.size()
                        && NodeState.selectedNode == networkNodes.get(position)) return;
                selectNode(position);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        urlInput.setText(prefs.getString(KEY_URL, "http://127.0.0.1:8787"));
        tokenInput.setText(prefs.getString(KEY_TOKEN, ""));
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tunnelCheck.setChecked(prefs.getBoolean(KEY_TUNNEL, false));
        urlInput.setEnabled(!tunnelCheck.isChecked());
        tunnelCheck.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean checked) {
                urlInput.setEnabled(!checked);
                if (checked) {
                    status("将经内置 frpc 连接 " + TunnelManager.localUrl(getApplicationContext())
                            + "（端口来自内置隧道模板：节点网关 18788 / hub 18790）");
                } else if (statusView.getText().toString().startsWith("将经内置")) {
                    status("");
                }
            }
        });

        connectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                connect();
            }
        });
        refreshButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                // A hub's node list and every node's state can change, so refresh re-reads the
                // whole connection; node mode only needs the workspace list.
                if (hubMode) {
                    connect();
                } else {
                    loadWorkspaces();
                }
            }
        });
        listView.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                JSONObject workspace = adapter.getItem(position);
                Intent intent = new Intent(MainActivity.this, SessionListActivity.class);
                intent.putExtra(SessionListActivity.EXTRA_WORKSPACE_ID, workspace.optString("id"));
                intent.putExtra(SessionListActivity.EXTRA_WORKSPACE_TITLE, Ui.workspaceLabel(workspace));
                startActivity(intent);
            }
        });

        String savedUrl = prefs.getString(KEY_URL, "");
        if (!savedUrl.isEmpty() || prefs.getBoolean(KEY_TUNNEL, false)) connect();
    }

    private void connect() {
        final boolean useTunnel = tunnelCheck.isChecked();
        final String typedUrl = ApiClient.normalize(urlInput.getText().toString());
        final String token = tokenInput.getText().toString().trim();
        if (!useTunnel && typedUrl.isEmpty()) {
            Ui.toast(this, "请填写中心服务器或节点地址");
            return;
        }
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_URL, typedUrl);
        editor.putString(KEY_TOKEN, token);
        editor.putBoolean(KEY_TUNNEL, useTunnel);
        editor.apply();

        NodeState.reset();
        NodeState.token = token;
        hubMode = false;
        networkNodes.clear();
        nodeAdapter.clear();
        adapter.setItems(null);
        emptyView.setText("连接后显示工作区");
        warningView.setVisibility(View.GONE);
        summaryView.setText("");
        setBusy(true);
        status(useTunnel ? "正在启动内置 frpc 并连接中转端口…" : "正在连接 " + typedUrl + " …");

        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String url = typedUrl;
                    if (useTunnel) {
                        TunnelManager.start(getApplicationContext());
                        url = TunnelManager.localUrl(getApplicationContext());
                    } else {
                        TunnelManager.stop();
                    }
                    final ApiClient client = new ApiClient(url, token);
                    final JSONObject info = client.get("/api/v1/info");
                    if (NodeState.detectHub(info)) {
                        startHub(client, url, token, info);
                    } else {
                        startNode(client, url, token, info);
                    }
                } catch (final IOException tunnelErr) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            TunnelManager.stop();
                            setBusy(false);
                            status("中转启动失败");
                            String message = tunnelErr.getMessage() == null
                                    ? "内置 frpc 启动失败" : tunnelErr.getMessage();
                            Ui.showError(MainActivity.this, new ApiException(0, message, "tunnel_error"));
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            setBusy(false);
                            status("连接失败");
                            Ui.showError(MainActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    /** Node mode (0.7 gateway): the gateway itself and its direct peers are the controllable nodes. */
    private void startNode(final ApiClient client, final String url, final String token,
                          final JSONObject info) throws ApiException {
        JSONObject dsh = info.optJSONObject("dsh");
        if (dsh == null || !dsh.optBoolean("workspaces")) {
            throw new ApiException(0,
                    "节点没有开启 DSH 工作区视图：在节点 config.json 把 dsh.enabled 和 dsh.exposeWorkspaces 设为 true，然后重启节点",
                    "dsh_disabled");
        }
        // Network discovery is a 0.7+ API. Older nodes still work as a single node.
        JSONObject network = null;
        try {
            network = client.get("/api/v1/network/nodes?depth=2&maxNodes=50");
        } catch (ApiException discoveryError) {
            network = null;
        }
        final JSONObject discovered = network;
        final JSONObject workspaces = client.get("/api/v1/dsh/workspaces");
        main.post(new Runnable() {
            @Override
            public void run() {
                hubMode = false;
                NodeState.baseUrl = url;
                NodeState.token = token;
                NodeState.client = client;
                NodeState.info = info;
                NodeState.network = discovered;
                NodeState.hubMode = false;
                NodeState.selectedNode = null;
                NodeState.selectedPeer = "";
                applyNodeNetwork(discovered);
                applyInfo();
                applyWorkspaces(workspaces);
                setBusy(false);
            }
        });
    }

    /** Hub mode (0.8 gateway): pick a node from the hub's enrollment table and read it via peer=. */
    private void startHub(final ApiClient client, final String url, final String token,
                         final JSONObject info) {
        JSONObject network = null;
        try {
            network = client.get("/api/v1/network/nodes");
        } catch (ApiException discoveryError) {
            network = null;
        }
        final JSONObject discovered = network;
        final List<JSONObject> views = hubNodes(discovered, info);
        final String peer = defaultPeer(info, views);
        JSONObject workspaces = null;
        ApiException workspacesFailure = null;
        JSONObject capabilities = null;
        JSONObject chosen = findNode(views, peer);
        final boolean chosenOffline = chosen != null && !chosen.optBoolean("reachable", true);
        // An offline node would only produce upstream_unreachable 502s; show its state and let
        // the user switch nodes instead of firing the reads.
        if (!peer.isEmpty() && !chosenOffline) {
            try {
                workspaces = client.get(NodeState.peerPath("/api/v1/dsh/workspaces", peer));
            } catch (ApiException workspacesError) {
                workspacesFailure = workspacesError;
            }
            try {
                capabilities = client.get(NodeState.peerPath("/api/v1/dsh/capabilities", peer));
            } catch (ApiException capabilitiesError) {
                // Leave capabilities empty: the screen shows read-only until the next refresh.
            }
        }
        final JSONObject workspacesResult = workspaces;
        final ApiException workspacesError = workspacesFailure;
        final JSONObject caps = capabilities;
        main.post(new Runnable() {
            @Override
            public void run() {
                hubMode = true;
                NodeState.baseUrl = url;
                NodeState.token = token;
                NodeState.client = client;
                NodeState.info = info;
                NodeState.network = discovered;
                NodeState.hubMode = true;
                networkNodes.clear();
                networkNodes.addAll(views);
                NodeState.nodes = new JSONArray();
                for (JSONObject node : networkNodes) NodeState.nodes.put(node);
                NodeState.selectedNode = null;
                NodeState.selectedPeer = "";
                JSONObject selected = findNode(peer);
                if (selected != null) {
                    NodeState.selectedNode = selected;
                    NodeState.selectedPeer = peer;
                    if (caps != null) {
                        try { selected.put("capabilities", caps); } catch (Exception ignored) { }
                    }
                }
                applyHubNodes();
                applyInfo();
                if (workspacesResult != null) {
                    applyWorkspaces(workspacesResult);
                } else {
                    adapter.setItems(null);
                    if (networkNodes.isEmpty()) {
                        emptyView.setText("中心服务器还没有登记节点");
                        status("已连接中心服务器 · 还没有登记节点");
                    } else if (chosenOffline) {
                        emptyView.setText("该节点离线，请选择在线节点");
                        status("已连接中心服务器 · " + peer + " 当前离线");
                    } else if (workspacesError != null) {
                        emptyView.setText("读取失败，可点“刷新工作区”重试");
                        status("已连接中心服务器 · 读取 " + peer + " 的工作区失败");
                        warningView.setVisibility(View.VISIBLE);
                        warningView.setText("读取 " + peer + " 的工作区失败：\n" + Ui.describe(workspacesError));
                    } else {
                        status("已连接中心服务器 · 没有可读取的节点");
                    }
                }
                setBusy(false);
            }
        });
    }

    /** The enrollment table, without the hub itself. Falls back to info.nodes for old hubs. */
    private static List<JSONObject> hubNodes(JSONObject network, JSONObject info) {
        List<JSONObject> result = new ArrayList<>();
        JSONArray nodes = network == null ? null : network.optJSONArray("nodes");
        if (nodes == null && info != null) nodes = info.optJSONArray("nodes");
        if (nodes == null) return result;
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject node = nodes.optJSONObject(i);
            if (node == null) continue;
            String kind = Ui.text(node, "kind");
            if ("hub".equals(kind)) continue;
            if (kind.isEmpty() && node.optBoolean("self", false)) continue;
            if (Ui.text(node, "name").isEmpty()) continue;
            result.add(node);
        }
        return result;
    }

    private static String defaultPeer(JSONObject info, List<JSONObject> nodes) {
        String preferred = info == null ? "" : Ui.text(info, "defaultNode");
        if (!preferred.isEmpty() && findNode(nodes, preferred) != null) return preferred;
        for (JSONObject node : nodes) {
            if (node.optBoolean("reachable", true)) return node.optString("name", "");
        }
        return nodes.isEmpty() ? "" : nodes.get(0).optString("name", "");
    }

    private static JSONObject findNode(List<JSONObject> nodes, String name) {
        if (name == null || name.isEmpty()) return null;
        for (JSONObject node : nodes) {
            if (name.equals(node.optString("name", ""))) return node;
        }
        return null;
    }

    private JSONObject findNode(String name) {
        return findNode(networkNodes, name);
    }

    private int indexOfPeer(String peer) {
        for (int i = 0; i < networkNodes.size(); i++) {
            if (peer.equals(networkNodes.get(i).optString("name", ""))) return i;
        }
        return -1;
    }

    /** Node-mode network list: the gateway itself plus its direct peers. */
    private void applyNodeNetwork(JSONObject network) {
        networkNodes.clear();
        JSONArray nodes = network == null ? null : network.optJSONArray("nodes");
        if (nodes != null) {
            for (int i = 0; i < nodes.length(); i++) {
                JSONObject node = nodes.optJSONObject(i);
                if (node != null) networkNodes.add(node);
            }
        }
        if (networkNodes.isEmpty() && NodeState.info != null) {
            // Fallback for nodes older than 0.7: present the gateway itself as the only node.
            JSONObject self = new JSONObject();
            try {
                self.put("name", NodeState.info.optString("name", "本机节点"));
                self.put("self", true);
                self.put("reachable", true);
                self.put("softwareVersion", NodeState.info.optString("softwareVersion",
                        NodeState.info.optString("version", "?")));
                self.put("dsh", NodeState.info.optJSONObject("dsh"));
                self.put("capabilities", NodeState.info.optJSONObject("capabilities"));
            } catch (Exception ignored) {
            }
            networkNodes.add(self);
        }
        nodeAdapter.clear();
        for (JSONObject node : networkNodes) nodeAdapter.add(nodeLabel(node));
        applyingNodes = true;
        nodeSpinner.setSelection(0);
        applyingNodes = false;
        lastDirectIndex = 0;
        NodeState.nodes = new JSONArray();
        for (JSONObject node : networkNodes) NodeState.nodes.put(node);
        NodeState.selectedNode = networkNodes.isEmpty() ? null : networkNodes.get(0);
        NodeState.selectedPeer = "";
    }

    /** Hub-mode spinner: every enrolled node with its online state. */
    private void applyHubNodes() {
        nodeAdapter.clear();
        for (JSONObject node : networkNodes) nodeAdapter.add(hubNodeLabel(node));
        int index = indexOfPeer(NodeState.selectedPeer);
        if (index < 0 && !networkNodes.isEmpty()) index = 0;
        applyingNodes = true;
        if (index >= 0) nodeSpinner.setSelection(index);
        applyingNodes = false;
        lastDirectIndex = Math.max(0, index);
        nodeSpinner.setEnabled(!networkNodes.isEmpty());
    }

    private void selectNode(int position) {
        if (position < 0 || position >= networkNodes.size()) return;
        final JSONObject node = networkNodes.get(position);
        if (hubMode) {
            if (!node.optBoolean("reachable", true)) {
                String heartbeat = Ui.shortIso(Ui.text(node, "lastHeartbeatAt"));
                Ui.toast(this, "节点 " + node.optString("name", "?") + " 当前离线"
                        + (heartbeat.isEmpty() ? "" : "（最后心跳 " + heartbeat + "）")
                        + "，无法读取或发送；请选择在线节点");
                applyingNodes = true;
                nodeSpinner.setSelection(lastDirectIndex);
                applyingNodes = false;
                return;
            }
            lastDirectIndex = position;
            NodeState.selectedNode = node;
            NodeState.selectedPeer = node.optString("name", "");
            applyInfo();
            loadHubCapabilities(node);
            loadWorkspaces();
            return;
        }
        boolean self = node.optBoolean("self", false);
        if (!self) {
            JSONArray via = node.optJSONArray("via");
            if (via != null && via.length() > 0) {
                Ui.toast(this, "该节点经 " + via.optString(0) + " 中转，暂不支持直接控制；"
                        + "请连接它路径上的直连节点");
                applyingNodes = true;
                nodeSpinner.setSelection(lastDirectIndex);
                applyingNodes = false;
                return;
            }
            if (!node.optBoolean("reachable", true)) {
                Ui.toast(this, "节点不可达：" + node.optString("error", "对端没有响应"));
                applyingNodes = true;
                nodeSpinner.setSelection(lastDirectIndex);
                applyingNodes = false;
                return;
            }
        }
        lastDirectIndex = position;
        NodeState.selectedNode = node;
        NodeState.selectedPeer = self ? "" : node.optString("name", "");
        applyInfo();
        loadWorkspaces();
    }

    /** Hub mode: capabilities live on the node, so the hub proxy is asked for the selected peer. */
    private void loadHubCapabilities(final JSONObject node) {
        final String peer = node.optString("name", "");
        if (peer.isEmpty() || NodeState.client == null) return;
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject caps = NodeState.client.get(
                            NodeState.peerPath("/api/v1/dsh/capabilities", peer));
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (!hubMode || !peer.equals(NodeState.selectedPeer)) return;
                            if (NodeState.selectedNode != node) return;
                            try { node.put("capabilities", caps); } catch (Exception ignored) { }
                            applyInfo();
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (hubMode && peer.equals(NodeState.selectedPeer)) applyInfo();
                        }
                    });
                }
            }
        });
    }

    private void loadWorkspaces() {
        if (NodeState.client == null) {
            connect();
            return;
        }
        if (hubMode && NodeState.selectedPeer.isEmpty()) {
            adapter.setItems(null);
            status("请选择一个节点");
            return;
        }
        if (NodeState.selectedNode != null && !NodeState.canView()) {
            adapter.setItems(null);
            status("该节点没有开放 DSH 工作区视图");
            return;
        }
        setBusy(true);
        status("正在读取 " + NodeState.nodeLabel() + " 的工作区…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject workspaces = NodeState.client.get(
                            NodeState.dshPath("/api/v1/dsh/workspaces"));
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            applyWorkspaces(workspaces);
                            setBusy(false);
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            setBusy(false);
                            if (hubMode) {
                                // A node behind the hub can drop offline at any moment; that is a
                                // routing state, not a fatal error, so keep it inline and let the
                                // user pick another node (or retry with the refresh button).
                                String peer = NodeState.selectedPeer.isEmpty()
                                        ? NodeState.nodeLabel() : NodeState.selectedPeer;
                                status("读取 " + peer + " 的工作区失败");
                                adapter.setItems(null);
                                emptyView.setText("读取失败，可点“刷新工作区”重试");
                                warningView.setVisibility(View.VISIBLE);
                                warningView.setText("读取 " + peer + " 的工作区失败：\n"
                                        + Ui.describe(err));
                                return;
                            }
                            status("读取失败");
                            Ui.showError(MainActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void applyInfo() {
        if (hubMode) {
            applyHubInfo();
            return;
        }
        StringBuilder summary = new StringBuilder();
        if (NodeState.isRemote()) {
            summary.append("控制 ").append(NodeState.nodeLabel())
                    .append("（经 ").append(NodeState.info == null ? "?" : NodeState.info.optString("name", "?"))
                    .append(" 中转）");
        } else {
            summary.append("节点 ").append(NodeState.nodeLabel())
                    .append(" · dsh-link ").append(NodeState.nodeVersion());
        }
        if (NodeState.network != null) {
            int total = NodeState.network.optInt("count", networkNodes.size());
            int reachable = 0;
            for (JSONObject node : networkNodes) if (node.optBoolean("reachable", false)) reachable++;
            summary.append(" · 网络 ").append(total).append(" 个节点 · ").append(reachable).append(" 可达");
        } else {
            summary.append(" · 该节点未提供网络扫描（需 0.7+）");
        }
        summaryView.setText(summary.toString());

        canSend = NodeState.canSend();
        if (!NodeState.canView()) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("该节点没有开放 DSH 工作区视图。\n"
                    + "在节点 config.json 设置 dsh.enabled=true、dsh.exposeWorkspaces=true，然后重启节点。");
        } else if (!canSend) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("只读模式：节点未放行 sessions.prompt。\n"
                    + "在节点 config.json 设置 capabilities.enabled=true，并把 sessions.prompt 加进 "
                    + "capabilities.methods；同时确认 DSH 内的 dsh-link bridge 插件正在运行。");
        } else {
            warningView.setVisibility(View.GONE);
        }
    }

    private void applyHubInfo() {
        int total = networkNodes.size();
        int online = 0;
        for (JSONObject node : networkNodes) if (node.optBoolean("reachable", false)) online++;
        StringBuilder summary = new StringBuilder();
        summary.append("中心服务器 ").append(NodeState.hubName())
                .append(" · dsh-link-hub ").append(NodeState.hubVersion());
        if (NodeState.network != null) {
            summary.append(" · ").append(total).append(" 个节点 · ").append(online).append(" 在线");
        } else {
            summary.append(" · ").append(total).append(" 个节点（中心服务器未提供 /network/nodes）");
        }
        if (NodeState.selectedNode != null) summary.append(" · 当前 ").append(NodeState.nodeLabel());
        summaryView.setText(summary.toString());

        canSend = NodeState.canSend();
        if (networkNodes.isEmpty()) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("中心服务器还没有登记任何节点。\n"
                    + "在每台 DSH 机器上执行 dshlink hub enroll 把节点登记到中心服务器，"
                    + "节点会通过 heartbeat 保持在线；本页点“连接/刷新工作区”重新读取。");
        } else if (NodeState.selectedNode == null) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("请选择一个节点。");
        } else if (!NodeState.selectedNode.optBoolean("reachable", true)) {
            String heartbeat = Ui.shortIso(Ui.text(NodeState.selectedNode, "lastHeartbeatAt"));
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("节点 " + NodeState.nodeLabel() + " 当前离线"
                    + (heartbeat.isEmpty() ? "" : "（最后心跳 " + heartbeat + "）") + "。\n"
                    + "节点离线时中心服务器无法转发 DSH 读取或发送请求；请检查节点进程、"
                    + "dshlink hub heartbeat 以及节点到中心服务器的网络。");
        } else if (!NodeState.canView()) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("该节点没有开放 DSH 工作区视图。\n"
                    + "在节点 config.json 设置 dsh.enabled=true、dsh.exposeWorkspaces=true，然后重启节点。");
        } else if (!canSend) {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("只读模式：节点未放行 sessions.prompt。\n"
                    + "在节点 config.json 设置 capabilities.enabled=true，并把 sessions.prompt 加进 "
                    + "capabilities.methods；同时确认 DSH 内的 dsh-link bridge 插件正在运行。"
                    + "中心服务器只负责转发，权限仍由节点决定。");
        } else {
            warningView.setVisibility(View.GONE);
        }
    }

    private void applyWorkspaces(JSONObject result) {
        JSONArray workspaces = result == null ? null : result.optJSONArray("workspaces");
        adapter.setItems(workspaces);
        int count = adapter.getCount();
        if (count == 0) {
            status("已连接，但没有可访问的工作区（检查 dsh.excludeWorkspaces）");
            return;
        }
        status("已连接 · " + count + " 个工作区 · " + NodeState.nodeLabel()
                + (canSend ? " · 可发送" : " · 只读"));
    }

    private static String nodeLabel(JSONObject node) {
        String name = node.optString("name", "");
        if (name.isEmpty()) name = node.optString("nodeId", "节点");
        if (node.optBoolean("self", false)) return name + "（本机）";
        JSONArray via = node.optJSONArray("via");
        if (via != null && via.length() > 0) return name + "（经 " + via.optString(0) + " 中转）";
        if (!node.optBoolean("reachable", true)) return name + "（不可达）";
        return name + "（直连）";
    }

    private static String hubNodeLabel(JSONObject node) {
        String name = node.optString("name", "");
        if (name.isEmpty()) name = node.optString("nodeId", "节点");
        if (!node.optBoolean("reachable", true)) {
            String heartbeat = Ui.shortIso(Ui.text(node, "lastHeartbeatAt"));
            return name + (heartbeat.isEmpty() ? "（离线）" : "（离线 · " + heartbeat + "）");
        }
        return name + "（在线）";
    }

    private void status(String text) {
        statusView.setText(text);
    }

    private void setBusy(boolean value) {
        connectButton.setEnabled(!value);
        refreshButton.setEnabled(!value && NodeState.client != null);
        nodeSpinner.setEnabled(!value && !networkNodes.isEmpty());
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) TunnelManager.stop();
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
