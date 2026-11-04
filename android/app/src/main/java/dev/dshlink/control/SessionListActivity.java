package dev.dshlink.control;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Sessions of one workspace. The list is only fetched on entry and on explicit refresh. */
public class SessionListActivity extends Activity {
    static final String EXTRA_WORKSPACE_ID = "workspaceId";
    static final String EXTRA_WORKSPACE_TITLE = "workspaceTitle";

    private String workspaceId;
    private CheckBox archivedCheck;
    private Button refreshButton;
    private TextView statusView;
    private ListView listView;
    private SessionAdapter adapter;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_session_list);
        Ui.applyEdgeToEdgePadding(this, false);
        workspaceId = getIntent().getStringExtra(EXTRA_WORKSPACE_ID);
        String title = getIntent().getStringExtra(EXTRA_WORKSPACE_TITLE);
        setTitle(title == null || title.isEmpty() ? "会话列表" : title);
        archivedCheck = findViewById(R.id.archived_check);
        refreshButton = findViewById(R.id.refresh_button);
        statusView = findViewById(R.id.status);
        listView = findViewById(R.id.session_list);
        adapter = new SessionAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(findViewById(R.id.empty));

        archivedCheck.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                load();
            }
        });
        refreshButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                load();
            }
        });
        listView.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                JSONObject session = adapter.getItem(position);
                Intent intent = new Intent(SessionListActivity.this, SessionActivity.class);
                intent.putExtra(SessionActivity.EXTRA_SESSION_ID, session.optString("sessionId"));
                intent.putExtra(SessionActivity.EXTRA_SESSION_TITLE, Ui.sessionTitle(session));
                startActivity(intent);
            }
        });
        load();
    }

    private void load() {
        if (NodeState.client == null) {
            Ui.toast(this, "尚未连接节点");
            finish();
            return;
        }
        refreshButton.setEnabled(false);
        statusView.setText("正在读取会话…");
        final boolean includeArchived = archivedCheck.isChecked();
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String query = "?limit=300&includeArchived=" + (includeArchived ? "1" : "0");
                    if (workspaceId != null && !workspaceId.isEmpty()) {
                        query += "&workspace=" + enc(workspaceId);
                    }
                    final JSONObject result = NodeState.client.get("/api/v1/dsh/sessions" + query);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            apply(result);
                            refreshButton.setEnabled(true);
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            refreshButton.setEnabled(true);
                            statusView.setText("读取失败");
                            Ui.showError(SessionListActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void apply(JSONObject result) {
        JSONArray sessions = result.optJSONArray("sessions");
        adapter.setItems(sessions);
        int count = adapter.getCount();
        statusView.setText(count == 0
                ? "没有会话（归档会话可勾选上方查看）"
                : "共 " + count + " 个会话 · 进入后才会拉取消息");
    }

    private static String enc(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException err) {
            return value;
        }
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
