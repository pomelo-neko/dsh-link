package dev.dshlink.control;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ListView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
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
    private static final String KEY_PROFILE_LABEL = "profile.label";
    private static final String KEY_PROFILE_ENTRY_KIND = "profile.entryKind";
    private static final String KEY_PROFILE_ENTRY_NAME = "profile.entryName";
    private static final String KEY_PROFILE_EXPIRES_AT = "profile.expiresAt";
    private static final String KEY_PROFILE_HAS_TUNNEL = "profile.hasTunnel";
    private static final int REQUEST_OPEN_PROFILE = 1001;
    private static final int REQUEST_SCAN_QR = 1002;

    private EditText urlInput;
    private EditText tokenInput;
    private CheckBox tunnelCheck;
    private Spinner nodeSpinner;
    private Button connectButton;
    private Button refreshButton;
    private Button importButton;
    private Button importFileButton;
    private Button scanButton;
    private TextView statusView;
    private TextView summaryView;
    private TextView warningView;
    private TextView emptyView;
    private TextView profileView;
    private Button resetCertButton;
    private Button clearProfileButton;
    private Button clearConnectionButton;
    private ListView listView;
    private WorkspaceAdapter adapter;
    private ArrayAdapter<String> nodeAdapter;
    private final List<JSONObject> networkNodes = new ArrayList<>();
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView connectStatusView;
    private TextView connectSummaryView;
    private TextView aboutView;
    private TextView tabWorkspaces;
    private TextView tabConnect;
    private TextView tabSettings;
    private View pageWorkspaces;
    private View pageConnect;
    private View pageSettings;
    private View nodeRow;
    private int currentTab;
    private boolean hubMode;
    private boolean canSend;
    private boolean applyingNodes;
    private int lastDirectIndex;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        Ui.applyEdgeToEdgePadding(this, true);
        pageWorkspaces = findViewById(R.id.page_workspaces);
        pageConnect = findViewById(R.id.page_connect);
        pageSettings = findViewById(R.id.page_settings);
        tabWorkspaces = findViewById(R.id.tab_workspaces);
        tabConnect = findViewById(R.id.tab_connect);
        tabSettings = findViewById(R.id.tab_settings);
        connectStatusView = findViewById(R.id.connect_status);
        connectSummaryView = findViewById(R.id.connect_summary);
        aboutView = findViewById(R.id.about_text);
        setupTabs();
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
        profileView = findViewById(R.id.profile_info);
        resetCertButton = findViewById(R.id.reset_cert_button);
        clearProfileButton = findViewById(R.id.clear_profile_button);
        clearConnectionButton = findViewById(R.id.clear_connection_button);
        listView = findViewById(R.id.workspace_list);
        adapter = new WorkspaceAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(emptyView);
        nodeRow = findViewById(R.id.node_row);

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
        applySecurityModeUi();
        updateProfileUi();
        tunnelCheck.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean checked) {
                urlInput.setEnabled(!checked);
                if (checked) {
                    String source = TunnelManager.hasImportedProfile(getApplicationContext())
                            ? "已导入的隧道配置" : "内置隧道模板；尚未导入隧道配置";
                    status("将经 frpc 连接 " + TunnelManager.localUrl(getApplicationContext())
                            + "（端口从 " + source + " 的 frpc.toml 读取）");
                } else if (statusView.getText().toString().startsWith("将经 frpc")) {
                    status("");
                }
            }
        });

        importButton = findViewById(R.id.import_button);
        importFileButton = findViewById(R.id.import_file_button);
        scanButton = findViewById(R.id.scan_button);
        importButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                openImportDialog();
            }
        });
        importFileButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                pickProfileFile();
            }
        });
        scanButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                startQrScan();
            }
        });
        resetCertButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                showResetCertDialog();
            }
        });
        clearProfileButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                confirmClearProfile();
            }
        });
        clearConnectionButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                confirmClearConnection();
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

        boolean handledLaunch = handleLaunchIntent(getIntent());
        String savedUrl = prefs.getString(KEY_URL, "");
        boolean certMode = PhoneIdentity.certMode(this);
        boolean hasSomethingToConnect = !savedUrl.isEmpty() || prefs.getBoolean(KEY_TUNNEL, false);
        if (!handledLaunch && hasSomethingToConnect
                && (!certMode || PhoneIdentity.hasCertificate(this)
                    || PhoneIdentity.hasBootstrap(this))) {
            connect();
        }
    }

    private void connect() {
        final boolean useTunnel = tunnelCheck.isChecked();
        final String typedUrl = ApiClient.normalize(urlInput.getText().toString());
        final boolean certMode = PhoneIdentity.certMode(this);
        // dshlink2（每设备证书）不需要 device token：mTLS 客户端证书本身就是凭据。
        final String token = certMode ? "" : tokenInput.getText().toString().trim();
        if (!useTunnel && typedUrl.isEmpty()) {
            Ui.toast(this, "请填写中心服务器或节点地址");
            return;
        }
        if (certMode && !typedUrl.startsWith("https://")) {
            Ui.toast(this, "证书模式要求 https:// 入口地址，请重新导入 dshlink2 连接串");
            return;
        }
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_URL, typedUrl);
        if (!certMode) editor.putString(KEY_TOKEN, token);
        editor.putBoolean(KEY_TUNNEL, useTunnel);
        editor.apply();

        NodeState.reset();
        NodeState.securityMode = certMode ? PhoneIdentity.MODE_CERT : PhoneIdentity.MODE_TOKEN;
        NodeState.token = token;
        NodeState.baseUrl = typedUrl;
        hubMode = false;
        networkNodes.clear();
        nodeAdapter.clear();
        adapter.setItems(null);
        emptyView.setText("还没有连接。\n先去“连接”页导入连接串或扫描二维码。");
        warningView.setVisibility(View.GONE);
        setSummary("");
        setBusy(true);
        if (certMode) {
            status(PhoneEnrollment.enrolled(this)
                    ? "正在用每设备证书建立 mTLS 连接…"
                    : "正在用一次性引导码申请设备证书（只发送公钥）…");
        } else {
            status(useTunnel ? "正在启动内置 frpc 并连接中转端口…" : "正在连接 " + typedUrl + " …");
        }

        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String url = typedUrl;
                    if (useTunnel) {
                        TunnelManager.start(getApplicationContext());
                        if (!certMode) url = TunnelManager.localUrl(getApplicationContext());
                    } else {
                        TunnelManager.stop();
                    }
                    ApiClient client;
                    if (certMode) {
                        // 一次性引导：只在本机还没有证书时发生，成功后会立即清掉 bootstrap secret。
                        PhoneEnrollment.enrollIfNeeded(getApplicationContext(), url);
                        client = new ApiClient(url, "",
                                PhoneIdentity.mutualTlsContext(getApplicationContext()));
                        // 服务器确认它看到了这张证书；顺带刷新本机保存的指纹/到期时间。
                        refreshCertificateMeta(client.get("/api/v1/phone/me"));
                    } else {
                        client = new ApiClient(url, token);
                    }
                    final JSONObject info = client.get("/api/v1/info");
                    if (NodeState.detectHub(info)) {
                        startHub(client, url, token, info);
                    } else {
                        startNode(client, url, token, info);
                    }
                } catch (final GeneralSecurityException certErr) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            setBusy(false);
                            status("设备证书准备失败");
                            updateProfileUi();
                            String message = certErr.getMessage() == null
                                    ? "无法建立 mTLS 连接" : certErr.getMessage();
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("设备证书准备失败")
                                    .setMessage(message + "\n\n请点“重置设备证书”后重新导入管理员签发的"
                                            + " dshlink2 引导码；若仍然失败，请确认手机系统时间正确，"
                                            + "并联系管理员确认 hub 的 CA 没有更换。")
                                    .setPositiveButton("知道了", null)
                                    .show();
                        }
                    });
                } catch (final IOException tunnelErr) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            TunnelManager.stop();
                            setBusy(false);
                            status("中转启动失败");
                            String message = tunnelErr.getMessage() == null
                                    ? "frpc 启动失败" : tunnelErr.getMessage();
                            if (message.contains("尚未导入隧道配置")) {
                                message += "\n\n点上面的“导入连接串/配置文件”，用 hub 管理员给你的连接串"
                                        + "导入隧道凭据；或者取消勾选“通过阿里云 STCP 中转”，"
                                        + "改用局域网/VPN 直连入口地址。";
                            }
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("中转启动失败")
                                    .setMessage(message)
                                    .setPositiveButton("知道了", null)
                                    .show();
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            setBusy(false);
                            status("连接失败");
                            updateProfileUi();
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
                applySecurityState();
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
                updateProfileUi();
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
                applySecurityState();
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
                updateProfileUi();
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

    /**
     * Node-mode control list: the gateway itself plus the peers it can reach directly. The remote
     * /network/nodes answer is deliberately not used for the selector: a node that is enrolled in a
     * hub reports the hub's whole network there (the hub is "self" from that node's uplink), so using
     * it would label this node with the hub's name and offer nodes the gateway cannot route to.
     */
    private void applyNodeNetwork(JSONObject network) {
        networkNodes.clear();
        if (NodeState.info != null) {
            JSONObject self = new JSONObject();
            try {
                self.put("name", NodeState.info.optString("name", "本机节点"));
                self.put("nodeId", NodeState.info.optString("nodeId", ""));
                self.put("self", true);
                self.put("reachable", true);
                self.put("softwareVersion", NodeState.info.optString("softwareVersion",
                        NodeState.info.optString("version", "?")));
                self.put("dsh", NodeState.info.optJSONObject("dsh"));
                self.put("capabilities", NodeState.info.optJSONObject("capabilities"));
            } catch (Exception ignored) {
            }
            networkNodes.add(self);
            // Direct peers of the gateway can be read via ?peer=<name>.
            JSONArray peers = NodeState.info.optJSONArray("peers");
            for (int i = 0; peers != null && i < peers.length(); i++) {
                JSONObject peer = peers.optJSONObject(i);
                if (peer == null) continue;
                String name = peer.optString("name", "");
                if (name.isEmpty()) continue;
                JSONObject node = new JSONObject();
                try {
                    node.put("name", name);
                    node.put("url", peer.optString("url", ""));
                    node.put("reachable", true);
                    node.put("via", new JSONArray());
                } catch (Exception ignored) {
                }
                networkNodes.add(node);
            }
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
        updateNodeRow();
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
        updateNodeRow();
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
            JSONArray discovered = NodeState.network.optJSONArray("nodes");
            int total = NodeState.network.optInt("count", discovered == null ? networkNodes.size() : discovered.length());
            int reachable = 0;
            if (discovered != null) {
                for (int i = 0; i < discovered.length(); i++) {
                    JSONObject node = discovered.optJSONObject(i);
                    if (node != null && node.optBoolean("reachable", false)) reachable++;
                }
            } else {
                for (JSONObject node : networkNodes) if (node.optBoolean("reachable", false)) reachable++;
            }
            summary.append(" · 网络 ").append(total).append(" 个节点 · ").append(reachable).append(" 可达");
        } else {
            summary.append(" · 该节点未提供网络扫描（需 0.7+）");
        }
        appendSecuritySummary(summary);
        setSummary(summary.toString());

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
        appendSecuritySummary(summary);
        setSummary(summary.toString());

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
        selectTab(0);
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

    /** Asks for a connection string / profile and also offers the system file picker. */
    private void openImportDialog() {
        final EditText input = new EditText(this);
        input.setHint("粘贴 dshlink2:（每设备证书）或 dshlink1:（device token）开头的连接串，"
                + "或打开管理员给你的 .json/.dshlink 文件后粘贴其中的内容");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setMinLines(5);
        input.setMaxLines(12);
        input.setGravity(Gravity.TOP | Gravity.START);
        int pad = Ui.dp(this, 16);
        FrameLayout box = new FrameLayout(this);
        box.setPadding(pad, Ui.dp(this, 4), pad, 0);
        box.addView(input, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        new AlertDialog.Builder(this)
                .setTitle("导入连接串/配置文件")
                .setMessage("连接串和配置文件由 hub 管理员生成。dshlink2: 是 0.6.0 的每设备证书模式"
                        + "（一次性引导码，首次连接自动换取证书，只发送公钥）；dshlink1: 是旧的"
                        + " device token 模式。两者都可能包含专用的 STCP 隧道凭据。"
                        + "导入后只保存在本机 App 私有目录。\n\n"
                        + "0.6.2 起也可以在“连接”页用“扫描二维码（相机）”直接扫管理员屏幕上的"
                        + "动态二维码，或者用“文件”一次多选 frame-01.png … 截图。")
                .setView(box)
                .setPositiveButton("导入", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        importText(input.getText().toString(), "粘贴的连接串");
                    }
                })
                .setNeutralButton("从文件/图片选择", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        pickProfileFile();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /**
     * Opens the system document picker for .txt/.json/.dshlink profiles and (0.6.2) QR-code
     * images; several frame images can be selected at once.
     */
    private void pickProfileFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/plain", "application/json",
                "application/octet-stream", "image/png", "image/jpeg", "image/webp", "image/gif",
                "image/bmp"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(intent, REQUEST_OPEN_PROFILE);
        } catch (ActivityNotFoundException err) {
            Ui.toast(this, "没有可用的文件选择器，请把配置内容粘贴到导入对话框");
        }
    }

    /** 0.6.2: opens the camera QR scanner; the assembled code comes back via EXTRA_CODE. */
    private void startQrScan() {
        try {
            startActivityForResult(new Intent(this, ScanActivity.class), REQUEST_SCAN_QR);
        } catch (RuntimeException err) {
            Ui.toast(this, "无法打开相机扫描界面");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK) return;
        if (requestCode == REQUEST_SCAN_QR) {
            String code = data == null ? null : data.getStringExtra(ScanActivity.EXTRA_CODE);
            if (code != null && !code.trim().isEmpty()) {
                importText(code, "扫描的二维码");
            } else {
                status("扫描已取消");
            }
            return;
        }
        if (requestCode != REQUEST_OPEN_PROFILE) return;
        importSelection(data);
    }

    /**
     * 0.6.2: the document picker accepts several files now. A single text file keeps the old
     * profile flow; picked images are decoded as QR frames and assembled into one connect code.
     */
    private void importSelection(Intent data) {
        if (data == null) return;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null && !uris.contains(uri)) uris.add(uri);
            }
        }
        Uri single = data.getData();
        if (single != null && !uris.contains(single)) uris.add(single);
        if (uris.isEmpty()) {
            status("没有选择文件");
            return;
        }
        if (uris.size() == 1 && !isImageUri(uris.get(0))) {
            Uri uri = uris.get(0);
            importUri(uri, "文件 " + displayName(uri));
            return;
        }
        importQrImages(uris);
    }

    /** Decodes the dshlink QR codes in the picked images and assembles them into one code. */
    private void importQrImages(final List<Uri> uris) {
        status("正在识别 " + uris.size() + " 个文件里的二维码…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                final QrAssembler assembler = new QrAssembler();
                final List<String> profileTexts = new ArrayList<>();
                final List<String> profileSources = new ArrayList<>();
                String directCode = null;
                int imageCount = 0;
                int readFailures = 0;
                int unrecognized = 0;
                String firstFailure = null;
                for (int i = 0; i < uris.size(); i++) {
                    Uri uri = uris.get(i);
                    String name = displayName(uri);
                    if (isImageUri(uri)) {
                        imageCount++;
                        final int progress = imageCount;
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                status("正在识别二维码图片 " + progress + "…");
                            }
                        });
                        try {
                            List<String> texts = QrImages.decodeAll(getApplicationContext(), uri);
                            for (String text : texts) {
                                String trimmed = text == null ? "" : text.trim();
                                if (trimmed.isEmpty()) continue;
                                if (QrAssembler.isFrame(trimmed)) {
                                    assembler.feed(trimmed);
                                } else if (directCode == null && looksLikeConnectCode(trimmed)) {
                                    directCode = trimmed;
                                } else {
                                    unrecognized++;
                                }
                            }
                        } catch (IOException err) {
                            readFailures++;
                            if (firstFailure == null) firstFailure = name + "：" + describeIo(err);
                        }
                        continue;
                    }
                    // A text file may be a config profile; anything parseable is kept as candidate.
                    try {
                        String content = readTextUri(uri);
                        if (content != null && !content.trim().isEmpty()) {
                            profileTexts.add(content);
                            profileSources.add(name);
                        }
                    } catch (IOException err) {
                        readFailures++;
                        if (firstFailure == null) firstFailure = name + "：" + describeIo(err);
                    }
                }

                final String assembled = directCode != null ? directCode
                        : (assembler.isComplete() ? assembler.code() : null);
                final String assembledSource = directCode != null
                        ? "二维码图片（单张完整连接串）"
                        : "二维码图片（" + assembler.total() + " 帧）";
                final int partialReceived = assembler.received();
                final int partialTotal = assembler.total();
                final boolean hasImage = imageCount > 0;
                final int failures = readFailures;
                final String failure = firstFailure;
                final int junk = unrecognized;
                final List<String> texts = profileTexts;
                final List<String> sources = profileSources;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (assembled != null) {
                            importText(assembled, assembledSource);
                            return;
                        }
                        if (!texts.isEmpty()) {
                            importText(texts.get(0), "文件 " + sources.get(0));
                            return;
                        }
                        status("导入失败");
                        if (partialTotal > 0) {
                            showQrImportError("只识别到 " + partialReceived + "/" + partialTotal
                                    + " 帧，连接串不完整。请把全部二维码截图一起选中"
                                    + "（frame-01.png … frame-"
                                    + String.format(Locale.ROOT, "%02d", partialTotal)
                                    + ".png），或改用相机扫描。");
                        } else if (hasImage && failures > 0) {
                            showQrImportError("所选图片读取/识别失败：" + failure);
                        } else if (hasImage && junk > 0) {
                            showQrImportError("识别到二维码，但内容不是 dsh-link 连接码。");
                        } else if (hasImage) {
                            showQrImportError("所选图片里没有识别到二维码。");
                        } else {
                            showImportError("所选文件里既没有连接配置，也没有可识别的二维码图片。");
                        }
                    }
                });
            }
        });
    }

    /** dshlink 连接串/JSON 配置判断，与 ConnectProfile 接受的前缀一致。 */
    private static boolean looksLikeConnectCode(String text) {
        return text.startsWith(ConnectProfile.PREFIX)
                || text.startsWith(ConnectProfile.PREFIX_V2)
                || text.startsWith("{");
    }

    /** True when the Uri should be decoded as a QR image (MIME type first, then extension). */
    private boolean isImageUri(Uri uri) {
        String type = null;
        try {
            type = getContentResolver().getType(uri);
        } catch (RuntimeException ignored) {
            // Some providers throw; fall back to the display name.
        }
        if (type != null) return type.startsWith("image/");
        String name = displayName(uri).toLowerCase(Locale.ROOT);
        return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")
                || name.endsWith(".webp") || name.endsWith(".gif") || name.endsWith(".bmp");
    }

    private static String describeIo(IOException err) {
        return err.getMessage() == null ? "未知错误" : err.getMessage();
    }

    /** 二维码图片导入专用错误提示（与配置文件导入的错误提示区分）。 */
    private void showQrImportError(String message) {
        new AlertDialog.Builder(this)
                .setTitle("二维码导入失败")
                .setMessage(message + "\n\n建议：\n"
                        + "· 相机扫描：对准管理员屏幕上的动态二维码，等它循环到全部帧；\n"
                        + "· 图片导入：把 frame-01.png … frame-08.png 一起多选后导入；\n"
                        + "· 二维码内容就是连接凭据，请让 hub 管理员现场展示。")
                .setPositiveButton("知道了", null)
                .show();
    }

    /** Reads a profile/document Uri off the UI thread and hands the text to importText. */
    private void importUri(final Uri uri, final String source) {
        status("正在读取连接配置文件…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                String text;
                try {
                    text = readTextUri(uri);
                } catch (final IOException err) {
                    final String message = err.getMessage() == null ? "未知错误" : err.getMessage();
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            status("导入失败");
                            showImportError("无法读取所选文件：" + message);
                        }
                    });
                    return;
                }
                final String content = text;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        importText(content, source);
                    }
                });
            }
        });
    }

    /** Handles "share text to app" / "open file with app" imports; true when something was imported. */
    private boolean handleLaunchIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text == null || text.trim().isEmpty()) return false;
            importText(text, "分享的连接串");
            return true;
        }
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            importUri(intent.getData(), "外部打开的文件");
            return true;
        }
        return false;
    }

    /** Parses the pasted/loaded profile off the UI thread, then applies and connects. */
    private void importText(final String text, final String source) {
        status("正在解析连接配置…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final ConnectProfile profile = ConnectProfile.parse(text);
                    profile.applyTunnelFiles(getApplicationContext());
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            applyProfile(profile, source);
                        }
                    });
                } catch (final IOException err) {
                    final String message = err.getMessage() == null
                            ? "无法导入连接配置" : err.getMessage();
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            status("导入失败");
                            showImportError(message);
                        }
                    });
                }
            }
        });
    }

    /** Stores an imported profile in prefs, fills the form and connects right away. */
    private void applyProfile(ConnectProfile profile, String source) {
        // A new profile may point at a different frpc visitor; restart the tunnel on connect.
        TunnelManager.stop();
        final boolean certMode = profile.isCertMode();
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_URL, profile.url);
        editor.putString(KEY_TOKEN, profile.token == null ? "" : profile.token);
        editor.putBoolean(KEY_TUNNEL, profile.hasTunnel);
        editor.putString(KEY_PROFILE_LABEL, profile.label);
        editor.putString(KEY_PROFILE_ENTRY_KIND, profile.entryKind);
        editor.putString(KEY_PROFILE_ENTRY_NAME, profile.entryName);
        editor.putString(KEY_PROFILE_EXPIRES_AT, profile.expiresAt);
        editor.putBoolean(KEY_PROFILE_HAS_TUNNEL, profile.hasTunnel);
        editor.apply();

        String securityNote;
        if (certMode) {
            // Compare before overwriting the pinned CA: re-importing the same hub+code must not
            // throw away a working certificate (and burn another bootstrap attempt).
            String storedCa = PhoneIdentity.caFingerprint(this);
            String storedBootstrap = PhoneIdentity.bootstrapId(this);
            boolean sameProfile = PhoneIdentity.sameFingerprint(profile.caFingerprint, storedCa)
                    && profile.bootstrapId.equals(storedBootstrap)
                    && PhoneIdentity.hasCertificate(this);
            PhoneIdentity.setSecureMode(this, PhoneIdentity.MODE_CERT);
            PhoneIdentity.setDeviceLabel(this, profile.label);
            PhoneIdentity.setCa(this, profile.caPem, profile.caFingerprint);
            if (!sameProfile) {
                // 新 hub 或新引导码：旧证书不再适用，连设备身份一起重置。
                // 服务端会拒绝已吊销的设备再次引导（phone_revoked），所以重新引导必须换新的
                // deviceId —— 这也是“被吊销后管理员重新签发引导码”能够恢复的方式。
                PhoneIdentity.resetCertificate(this, true);
                PhoneIdentity.setBootstrap(this, profile.bootstrapId, profile.bootstrapSecret,
                        profile.bootstrapExpiresAt);
            }
            securityNote = sameProfile
                    ? "本机已有该 hub 的设备证书，将直接复用（不重复兑换引导码）。"
                    : "首次连接会自动用一次性引导码兑换每设备证书，并且只发送公钥。";
        } else {
            PhoneIdentity.setSecureMode(this, PhoneIdentity.MODE_TOKEN);
            PhoneIdentity.clearBootstrapSecret(this);
            securityNote = "使用 device token（Bearer）连接；dshlink1: 旧路径保持可用。";
        }

        urlInput.setText(profile.url);
        urlInput.setEnabled(!profile.hasTunnel);
        tokenInput.setText(certMode ? "" : profile.token);
        tunnelCheck.setChecked(profile.hasTunnel);
        applySecurityModeUi();
        updateProfileUi();

        String message = profile.summary() + "\n来源：" + source + "\n\n" + securityNote;
        if (profile.expired()) {
            message += "\n\n注意：该连接配置已过期，连接可能被拒绝；请让 hub 管理员重新生成。";
        }
        new AlertDialog.Builder(this)
                .setTitle("已导入连接配置")
                .setMessage(message)
                .setPositiveButton("开始连接", null)
                .show();
        connect();
    }

    /** Shows which connection profile is stored plus the active security mode (token vs certificate). */
    private void updateProfileUi() {
        if (profileView == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String label = prefs.getString(KEY_PROFILE_LABEL, "");
        boolean certMode = PhoneIdentity.certMode(this);
        boolean hasCertificate = PhoneIdentity.hasCertificate(this);
        boolean hasProfile = !label.isEmpty() || certMode;
        String savedUrl = prefs.getString(KEY_URL, "");
        if (!hasProfile) {
            if (NodeState.client != null) {
                // Manual token connection: still tell the user what this phone is currently bound to.
                profileView.setText("当前连接：" + NodeState.baseUrl
                        + "\n安全模式：设备 token（Bearer） · 未导入连接配置");
                profileView.setVisibility(View.VISIBLE);
            } else {
                profileView.setVisibility(View.GONE);
            }
        } else {
            String entryName = prefs.getString(KEY_PROFILE_ENTRY_NAME, "");
            String entryKind = prefs.getString(KEY_PROFILE_ENTRY_KIND, "hub");
            String expiresAt = prefs.getString(KEY_PROFILE_EXPIRES_AT, "");
            boolean hasTunnel = prefs.getBoolean(KEY_PROFILE_HAS_TUNNEL, false);
            StringBuilder text = new StringBuilder("已导入：")
                    .append(label.isEmpty() ? "（未命名）" : label)
                    .append(" · ").append("node".equals(entryKind) ? "节点" : "中心服务器");
            if (!entryName.isEmpty()) text.append(" ").append(entryName);
            if (!expiresAt.isEmpty()) text.append(" · 到期 ").append(ConnectProfile.formatExpires(expiresAt));
            text.append(" · ").append(hasTunnel ? "含内置隧道" : "无隧道（直连）");
            if (certMode) {
                text.append("\n安全模式：每设备证书（mTLS） · CA ")
                        .append(shortFingerprint(PhoneIdentity.caFingerprint(this)));
                text.append("\n设备证书：");
                if (hasCertificate) {
                    text.append(shortFingerprint(PhoneIdentity.certFingerprint(this)));
                    String validTo = PhoneIdentity.certValidTo(this);
                    if (!validTo.isEmpty()) {
                        text.append(" · 到期 ").append(ConnectProfile.formatExpires(validTo));
                    }
                    text.append(" · 私钥 ").append(PhoneIdentity.keyStorageLabel(this));
                } else {
                    text.append("尚未引导（首次连接自动兑换引导码） · 私钥 ")
                            .append(PhoneIdentity.keyStorageLabel(this));
                }
            } else {
                text.append("\n安全模式：设备 token（Bearer）");
                if (hasCertificate) text.append(" · 本机另有设备证书（重新导入 dshlink2 可切回）");
            }
            profileView.setText(text.toString());
            profileView.setVisibility(View.VISIBLE);
        }
        if (resetCertButton != null) {
            resetCertButton.setVisibility(hasProfile || hasCertificate ? View.VISIBLE : View.GONE);
        }
        if (clearProfileButton != null) {
            clearProfileButton.setVisibility(hasProfile ? View.VISIBLE : View.GONE);
        }
        if (clearConnectionButton != null) {
            boolean saved = NodeState.client != null || (!savedUrl.isEmpty() && !hasProfile);
            clearConnectionButton.setVisibility(saved ? View.VISIBLE : View.GONE);
        }
        if (aboutView != null) {
            aboutView.setText("dsh-link 控制端 " + ApiClient.APP_VERSION + "（Android）"
                    + "\n连接方式：" + (certMode ? "每设备证书（mTLS，dshlink2）" : "设备 token（dshlink1）")
                    + "\n节点/hub 的版本见“工作区”页顶部摘要。");
        }
    }

    /** The node selector only makes sense when there is more than one controllable node. */
    private void updateNodeRow() {
        if (nodeRow == null) return;
        boolean show = hubMode ? !networkNodes.isEmpty() : networkNodes.size() > 1;
        nodeRow.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private void showImportError(String message) {
        new AlertDialog.Builder(this)
                .setTitle("导入失败")
                .setMessage(message + "\n\n请向 hub 管理员索取新的连接串/配置文件：0.6.0 的每设备证书"
                        + "连接串以 dshlink2: 开头，旧的 device token 连接串以 dshlink1: 开头；"
                        + "文件导入支持 .json/.txt/.dshlink 内容。")
                .setPositiveButton("知道了", null)
                .show();
    }

    private String readTextUri(Uri uri) throws IOException {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("文件不可读");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > 4 * 1024 * 1024) {
                    throw new IOException("文件超过 4 MB，可能不是连接配置文件");
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        android.database.Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri,
                    new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        } catch (RuntimeException ignored) {
            // Some providers reject the query; the last path segment is good enough for a label.
        } finally {
            if (cursor != null) cursor.close();
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return name == null ? uri.toString() : name;
    }

    /** Copies cert-mode identity state (fingerprint/validity/CA) into NodeState for the summary. */
    private void applySecurityState() {
        boolean certMode = PhoneIdentity.certMode(getApplicationContext());
        NodeState.securityMode = certMode ? PhoneIdentity.MODE_CERT : PhoneIdentity.MODE_TOKEN;
        if (certMode) {
            NodeState.deviceFingerprint = PhoneIdentity.certFingerprint(getApplicationContext());
            NodeState.deviceValidTo = PhoneIdentity.certValidTo(getApplicationContext());
            NodeState.caFingerprint = PhoneIdentity.caFingerprint(getApplicationContext());
        }
    }

    /** Token input is meaningless in certificate mode: lock it and explain why. */
    private void applySecurityModeUi() {
        boolean certMode = PhoneIdentity.certMode(this);
        tokenInput.setEnabled(!certMode);
        if (certMode) {
            tokenInput.setText("");
            tokenInput.setHint("dshlink2 使用每设备证书（mTLS），不需要 token");
        } else {
            tokenInput.setHint("device token（hub 必填；节点可留空）");
        }
    }

    private void appendSecuritySummary(StringBuilder summary) {
        if (!NodeState.certMode()) return;
        summary.append(" · 每设备证书 mTLS");
        String fingerprint = NodeState.deviceFingerprint;
        if (fingerprint != null && !fingerprint.isEmpty()) {
            summary.append("（").append(shortFingerprint(fingerprint)).append("）");
        }
    }

    /** Last 12 hex digits of a SHA-256 fingerprint, enough to compare on screen. */
    private static String shortFingerprint(String value) {
        String normalized = PhoneIdentity.normalizeFingerprint(value);
        if (normalized.isEmpty()) return "未知";
        if (normalized.length() <= 12) return normalized;
        return "…" + normalized.substring(normalized.length() - 12);
    }

    /** Reads /api/v1/phone/me and refreshes the locally cached certificate metadata. */
    private void refreshCertificateMeta(JSONObject me) {
        JSONObject device = me == null ? null : me.optJSONObject("device");
        if (device != null) {
            String fingerprint = Ui.text(device, "fingerprint");
            String validTo = Ui.text(device, "validTo");
            if (validTo.isEmpty()) validTo = Ui.text(device, "expiresAt");
            String certPem = PhoneIdentity.certPem(getApplicationContext());
            if (!fingerprint.isEmpty() && !certPem.isEmpty()) {
                PhoneIdentity.setCertificate(getApplicationContext(), certPem, fingerprint, validTo);
            }
        }
        JSONObject ca = me == null ? null : me.optJSONObject("ca");
        if (ca != null) {
            String caFingerprint = Ui.text(ca, "fingerprint");
            if (!caFingerprint.isEmpty()
                    && !PhoneIdentity.sameFingerprint(caFingerprint,
                        PhoneIdentity.caFingerprint(getApplicationContext()))) {
                // The server's CA does not match the imported profile: absolutely worth knowing.
                status("警告：服务器 CA 指纹与导入的连接串不一致");
            }
        }
        applySecurityState();
    }

    /** 0.6.0 "reset device certificate": keep identity, rotate identity, or import a new code. */
    private void showResetCertDialog() {
        boolean certMode = PhoneIdentity.certMode(this);
        final String[] items = certMode
                ? new String[]{
                    "重置设备证书（保留设备身份，用新引导码重新兑换）",
                    "重置证书并更换设备身份（清空 deviceId）",
                    "导入新的 dshlink2 引导码"}
                : new String[]{
                    "清除本机保存的设备证书与密钥",
                    "导入新的 dshlink2 引导码"};
        new AlertDialog.Builder(this)
                .setTitle("重置设备证书")
                .setMessage("每设备证书模式下，证书就是登录凭据。重置后本机需要用 hub 管理员新签发的"
                        + " dshlink2 引导码重新兑换；旧证书在 hub 上仍显示为已注册，直到管理员吊销。")
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) {
                            PhoneIdentity.resetCertificate(MainActivity.this, false);
                            updateProfileUi();
                            status("已重置设备证书；请导入管理员签发的 dshlink2 引导码重新兑换");
                            Ui.toast(MainActivity.this, "设备证书已重置，需要用新的引导码重新兑换");
                        } else if (items.length == 3 && which == 1) {
                            PhoneIdentity.resetCertificate(MainActivity.this, true);
                            updateProfileUi();
                            status("已重置设备证书并更换设备身份；请导入新的 dshlink2 引导码");
                            Ui.toast(MainActivity.this, "证书与设备身份已重置");
                        } else {
                            openImportDialog();
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void confirmClearProfile() {
        new AlertDialog.Builder(this)
                .setTitle("清除导入配置")
                .setMessage("将清除本机保存的连接串信息、设备证书与隧道配置（设备身份 deviceId 会保留）。"
                        + "之后可用 hub 管理员给的新连接串重新导入。")
                .setPositiveButton("清除", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        clearImportedProfile();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void confirmClearConnection() {
        new AlertDialog.Builder(this)
                .setTitle("清除连接")
                .setMessage("将清除已保存的节点地址与 device token，并断开当前连接。"
                        + "导入的连接配置与设备证书不受影响（用上面的按钮单独清除）。")
                .setPositiveButton("清除", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        clearSavedConnection();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void clearSavedConnection() {
        TunnelManager.stop();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_TUNNEL)
                .apply();
        NodeState.reset();
        nodeAdapter.clear();
        adapter.setItems(null);
        urlInput.setText("http://127.0.0.1:8787");
        urlInput.setEnabled(true);
        tokenInput.setText("");
        tunnelCheck.setChecked(false);
        emptyView.setText("还没有连接。\n先去“连接”页导入连接串或扫描二维码。");
        setSummary("");
        warningView.setVisibility(View.GONE);
        applySecurityModeUi();
        updateProfileUi();
        updateNodeRow();
        status("已清除连接；填入地址与令牌后可重新连接");
    }

    private void clearImportedProfile() {
        TunnelManager.stop();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_TUNNEL)
                .remove(KEY_PROFILE_LABEL).remove(KEY_PROFILE_ENTRY_KIND)
                .remove(KEY_PROFILE_ENTRY_NAME).remove(KEY_PROFILE_EXPIRES_AT)
                .remove(KEY_PROFILE_HAS_TUNNEL)
                .apply();
        PhoneIdentity.clearProfileSecurity(getApplicationContext());
        NodeState.reset();
        nodeAdapter.clear();
        adapter.setItems(null);
        urlInput.setText("http://127.0.0.1:8787");
        urlInput.setEnabled(true);
        tokenInput.setText("");
        tunnelCheck.setChecked(false);
        emptyView.setText("还没有连接。\n先去“连接”页导入连接串或扫描二维码。");
        setSummary("");
        warningView.setVisibility(View.GONE);
        applySecurityModeUi();
        updateProfileUi();
        status("已清除导入配置；请向 hub 管理员索取新的连接串");
    }

    /** Workspaces page and connect page show the same status line; keep them in sync. */
    private void status(String text) {
        statusView.setText(text);
        if (connectStatusView != null) connectStatusView.setText(text);
    }

    private void setSummary(String text) {
        summaryView.setText(text);
        if (connectSummaryView != null) connectSummaryView.setText(text);
    }

    /**
     * Three top-level areas (workspaces is the app's main body). On phones they are a bottom tab
     * bar; on tablets/foldables widened past 600dp the layout-sw600dp variant turns the same ids
     * into a left sidebar, so no activity code depends on the form factor.
     */
    private void setupTabs() {
        View.OnClickListener listener = new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                int id = view.getId();
                if (id == R.id.tab_workspaces) {
                    selectTab(0);
                } else if (id == R.id.tab_connect) {
                    selectTab(1);
                } else if (id == R.id.tab_settings) {
                    selectTab(2);
                }
            }
        };
        tabWorkspaces.setOnClickListener(listener);
        tabConnect.setOnClickListener(listener);
        tabSettings.setOnClickListener(listener);
        selectTab(0);
        updateNodeRow();
    }

    private void selectTab(int tab) {
        currentTab = tab;
        pageWorkspaces.setVisibility(tab == 0 ? View.VISIBLE : View.GONE);
        pageConnect.setVisibility(tab == 1 ? View.VISIBLE : View.GONE);
        pageSettings.setVisibility(tab == 2 ? View.VISIBLE : View.GONE);
        applyTabStyle(tabWorkspaces, tab == 0);
        applyTabStyle(tabConnect, tab == 1);
        applyTabStyle(tabSettings, tab == 2);
    }

    private void applyTabStyle(TextView tab, boolean selected) {
        if (tab == null) return;
        tab.setTextColor(selected ? 0xFF1E3A5F : 0xFF6B7280);
        tab.setTypeface(null, selected ? Typeface.BOLD : Typeface.NORMAL);
        tab.setBackgroundColor(selected ? 0xFFE8F0FA : 0x00000000);
    }

    @Override
    public void onBackPressed() {
        if (currentTab != 0) {
            selectTab(0);
            return;
        }
        super.onBackPressed();
    }

    private void setBusy(boolean value) {
        connectButton.setEnabled(!value);
        refreshButton.setEnabled(!value && NodeState.client != null);
        nodeSpinner.setEnabled(!value && !networkNodes.isEmpty());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) TunnelManager.stop();
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
