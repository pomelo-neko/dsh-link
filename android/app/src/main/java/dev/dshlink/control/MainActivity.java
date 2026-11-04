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
 * Connect to a dsh-link node and browse the DSH workspaces of any node in its network.
 *
 * The app always talks to one gateway node. /api/v1/network/nodes discovers the nodes reachable
 * through that gateway; selecting a direct peer only changes the "peer" parameter used by the DSH
 * view calls. Nothing is polled on this screen: data is fetched on connect or refresh.
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
    private ListView listView;
    private WorkspaceAdapter adapter;
    private ArrayAdapter<String> nodeAdapter;
    private final List<JSONObject> networkNodes = new ArrayList<>();
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean busy;
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
        listView = findViewById(R.id.workspace_list);
        adapter = new WorkspaceAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(findViewById(R.id.empty));

        nodeAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item,
                new ArrayList<String>());
        nodeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        nodeSpinner.setAdapter(nodeAdapter);
        nodeSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (!applyingNodes) selectNode(position);
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
        tunnelCheck.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(android.widget.CompoundButton buttonView, boolean checked) {
                urlInput.setEnabled(!checked);
                if (checked) {
                    status("将经 8788 网关连接 " + TunnelManager.LOCAL_URL + "（需 device token）");
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
                loadWorkspaces();
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
        final String url = useTunnel ? TunnelManager.LOCAL_URL : typedUrl;
        final String token = tokenInput.getText().toString().trim();
        if (!useTunnel && url.isEmpty()) {
            Ui.toast(this, "请填写节点地址");
            return;
        }
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_URL, typedUrl);
        editor.putString(KEY_TOKEN, token);
        editor.putBoolean(KEY_TUNNEL, useTunnel);
        editor.apply();

        NodeState.reset();
        NodeState.token = token;
        networkNodes.clear();
        nodeAdapter.clear();
        adapter.setItems(null);
        setBusy(true);
        status(useTunnel ? "正在启动内置 frpc 并经 8788 网关连接…" : "正在连接 " + url + " …");
        summaryView.setText("");
        warningView.setVisibility(View.GONE);

        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (useTunnel) {
                        TunnelManager.start(getApplicationContext());
                    } else {
                        TunnelManager.stop();
                    }
                    final ApiClient client = new ApiClient(url, token);
                    final JSONObject info = client.get("/api/v1/info");
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
                            NodeState.baseUrl = url;
                            NodeState.token = token;
                            NodeState.client = client;
                            NodeState.info = info;
                            NodeState.network = discovered;
                            NodeState.selectedNode = null;
                            NodeState.selectedPeer = "";
                            applyNetwork(discovered);
                            applyInfo();
                            applyWorkspaces(workspaces);
                            setBusy(false);
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

    private void applyNetwork(JSONObject network) {
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

    private void selectNode(int position) {
        if (position < 0 || position >= networkNodes.size()) return;
        JSONObject node = networkNodes.get(position);
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

    private void loadWorkspaces() {
        if (NodeState.client == null) {
            connect();
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
                            status("读取失败");
                            Ui.showError(MainActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void applyInfo() {
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

    private void applyWorkspaces(JSONObject result) {
        JSONArray workspaces = result == null ? null : result.optJSONArray("workspaces");
        adapter.setItems(workspaces);
        int count = adapter.getCount();
        status("已连接 · " + count + " 个工作区 · " + NodeState.nodeLabel()
                + (canSend ? " · 可发送" : " · 只读"));
        if (count == 0) status("已连接，但没有可访问的工作区（检查 dsh.excludeWorkspaces）");
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

    private void status(String text) {
        statusView.setText(text);
    }

    private void setBusy(boolean value) {
        busy = value;
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
