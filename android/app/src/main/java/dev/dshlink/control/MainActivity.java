package dev.dshlink.control;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.View;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Connect to a dsh-link node and browse its DSH workspaces.
 *
 * Nothing is polled on this screen: the workspace list is fetched once when the user connects or
 * taps refresh, so an idle phone transfers no data.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "dshlink";
    private static final String KEY_URL = "url";
    private static final String KEY_TOKEN = "token";

    private EditText urlInput;
    private EditText tokenInput;
    private Button connectButton;
    private Button refreshButton;
    private TextView statusView;
    private TextView summaryView;
    private TextView warningView;
    private ListView listView;
    private WorkspaceAdapter adapter;
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean busy;
    private boolean canSend;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        urlInput = findViewById(R.id.url_input);
        tokenInput = findViewById(R.id.token_input);
        connectButton = findViewById(R.id.connect_button);
        refreshButton = findViewById(R.id.refresh_button);
        statusView = findViewById(R.id.status);
        summaryView = findViewById(R.id.summary);
        warningView = findViewById(R.id.warning);
        listView = findViewById(R.id.workspace_list);
        adapter = new WorkspaceAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(findViewById(R.id.empty));

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        urlInput.setText(prefs.getString(KEY_URL, "http://127.0.0.1:8787"));
        tokenInput.setText(prefs.getString(KEY_TOKEN, ""));
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

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
        if (!savedUrl.isEmpty()) connect();
    }

    private void connect() {
        final String url = ApiClient.normalize(urlInput.getText().toString());
        final String token = tokenInput.getText().toString().trim();
        if (url.isEmpty()) {
            Ui.toast(this, "请填写节点地址");
            return;
        }
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_URL, url);
        editor.putString(KEY_TOKEN, token);
        editor.apply();

        NodeState.reset();
        NodeState.baseUrl = url;
        NodeState.token = token;
        NodeState.client = new ApiClient(url, token);
        setBusy(true);
        status("正在连接 " + url + " …");
        summaryView.setText("");
        warningView.setVisibility(View.GONE);

        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject info = NodeState.client.get("/api/v1/info");
                    JSONObject dsh = info.optJSONObject("dsh");
                    if (dsh == null || !dsh.optBoolean("workspaces")) {
                        throw new ApiException(0,
                                "节点没有开启 DSH 工作区视图：在节点 config.json 把 dsh.enabled 和 dsh.exposeWorkspaces 设为 true，然后重启节点",
                                "dsh_disabled");
                    }
                    final JSONObject workspaces = NodeState.client.get("/api/v1/dsh/workspaces");
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            NodeState.info = info;
                            applyInfo(info);
                            applyWorkspaces(workspaces);
                            setBusy(false);
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

    private void loadWorkspaces() {
        if (NodeState.client == null) {
            connect();
            return;
        }
        setBusy(true);
        status("正在刷新工作区…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject workspaces = NodeState.client.get("/api/v1/dsh/workspaces");
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
                            status("刷新失败");
                            Ui.showError(MainActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void applyInfo(JSONObject info) {
        String name = info.optString("name", "?");
        String version = info.optString("softwareVersion", info.optString("version", "?"));
        summaryView.setText("节点 " + name + " · dsh-link " + version);
        JSONObject caps = info.optJSONObject("capabilities");
        boolean enabled = caps != null && caps.optBoolean("enabled");
        JSONArray methods = caps == null ? null : caps.optJSONArray("methods");
        canSend = enabled && Ui.contains(methods, "sessions.prompt");
        if (canSend) {
            warningView.setVisibility(View.GONE);
        } else {
            warningView.setVisibility(View.VISIBLE);
            warningView.setText("只读模式：节点未放行 sessions.prompt。\n"
                    + "在节点 config.json 设置 capabilities.enabled=true，并把 sessions.prompt 加进 "
                    + "capabilities.methods；同时确认 DSH 内的 dsh-link bridge 插件正在运行。");
        }
    }

    private void applyWorkspaces(JSONObject result) {
        JSONArray workspaces = result.optJSONArray("workspaces");
        adapter.setItems(workspaces);
        int count = adapter.getCount();
        status("已连接 · " + count + " 个工作区" + (canSend ? " · 可发送" : " · 只读"));
        if (count == 0) status("已连接，但没有可访问的工作区（检查 dsh.excludeWorkspaces）");
    }

    private void status(String text) {
        statusView.setText(text);
    }

    private void setBusy(boolean value) {
        busy = value;
        connectButton.setEnabled(!value);
        refreshButton.setEnabled(!value && NodeState.client != null);
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
