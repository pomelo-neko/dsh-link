package dev.dshlink.control;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * One DSH session: read the transcript and (when the node allows sessions.prompt) send a message.
 *
 * Foreground only: transcript deltas are pulled every 2.5s between onStart and onStop. When the
 * screen is not visible nothing is polled, so an idle phone never pulls data in the background.
 */
public class SessionActivity extends Activity {
    static final String EXTRA_SESSION_ID = "sessionId";
    static final String EXTRA_SESSION_TITLE = "sessionTitle";
    private static final long POLL_MS = 2500;
    private static final int PAGE = 200;

    private String sessionId;
    private ListView listView;
    private MessageAdapter adapter;
    private TextView statusView;
    private Button loadOlderButton;
    private Button sendButton;
    private EditText input;
    private CheckBox steerCheck;
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Long> seenSeq = new HashSet<>();
    private long lastSeq;
    private int loadedCount;
    private long totalCount;
    private boolean initialLoaded;
    private boolean active;
    private boolean pollScheduled;
    private volatile boolean pollInFlight;
    private boolean canSend;
    private boolean sending;

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            pollScheduled = false;
            if (!active) return;
            if (initialLoaded) pollOnce();
            schedulePolling();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_session);
        sessionId = getIntent().getStringExtra(EXTRA_SESSION_ID);
        String title = getIntent().getStringExtra(EXTRA_SESSION_TITLE);
        setTitle(title == null || title.isEmpty() ? "会话" : title);
        listView = findViewById(R.id.message_list);
        statusView = findViewById(R.id.status);
        loadOlderButton = findViewById(R.id.load_older);
        sendButton = findViewById(R.id.send_button);
        input = findViewById(R.id.input);
        steerCheck = findViewById(R.id.steer_check);
        adapter = new MessageAdapter(this);
        listView.setAdapter(adapter);
        listView.setEmptyView(findViewById(R.id.empty));

        canSend = NodeState.canSend();
        if (!canSend) {
            input.setEnabled(false);
            sendButton.setEnabled(false);
            steerCheck.setEnabled(false);
            input.setHint("只读：节点未放行 sessions.prompt");
        }

        loadOlderButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                loadOlder();
            }
        });
        sendButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                send();
            }
        });
        loadInitial();
    }

    @Override
    protected void onStart() {
        super.onStart();
        active = true;
        if (initialLoaded) schedulePolling();
    }

    @Override
    protected void onStop() {
        active = false;
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void schedulePolling() {
        if (!active || pollScheduled) return;
        pollScheduled = true;
        main.postDelayed(pollTask, POLL_MS);
    }

    private void loadInitial() {
        statusView.setText("正在读取会话…");
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject result = NodeState.client.get(
                            "/api/v1/dsh/sessions/" + enc(sessionId) + "/transcript?tail=1&limit=" + PAGE);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            JSONArray messages = result.optJSONArray("messages");
                            adapter.setItems(messages);
                            seenSeq.clear();
                            rememberSeqs(messages);
                            lastSeq = result.optLong("latestSeq", 0);
                            loadedCount = messages == null ? 0 : messages.length();
                            totalCount = result.optLong("total", loadedCount);
                            initialLoaded = true;
                            updateOlderButton();
                            statusView.setText("共 " + totalCount + " 条 · 每 2.5 秒仅在前台刷新");
                            scrollToBottom();
                            schedulePolling();
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            statusView.setText("读取失败");
                            Ui.showError(SessionActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void pollOnce() {
        if (pollInFlight) return;
        pollInFlight = true;
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    long cursor = lastSeq;
                    final JSONArray fresh = new JSONArray();
                    for (int page = 0; page < 10; page++) {
                        JSONObject chunk = NodeState.client.get("/api/v1/dsh/sessions/" + enc(sessionId)
                                + "/transcript?sinceSeq=" + cursor + "&limit=" + PAGE);
                        JSONArray messages = chunk.optJSONArray("messages");
                        if (messages == null || messages.length() == 0) break;
                        for (int i = 0; i < messages.length(); i++) {
                            JSONObject message = messages.optJSONObject(i);
                            if (message == null) continue;
                            long seq = message.optLong("seq", -1);
                            if (seq > 0 && seenSeq.contains(seq)) continue;
                            if (seq > 0) seenSeq.add(seq);
                            fresh.put(message);
                        }
                        long next = messages.optJSONObject(messages.length() - 1) == null
                                ? cursor : messages.optJSONObject(messages.length() - 1).optLong("seq", cursor);
                        if (next <= cursor) break;
                        cursor = next;
                        if (messages.length() < PAGE) break;
                    }
                    final long head = cursor;
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            lastSeq = Math.max(lastSeq, head);
                            if (fresh.length() > 0) {
                                adapter.append(fresh);
                                loadedCount += fresh.length();
                                scrollToBottom();
                            }
                            updateOlderButton();
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (active) statusView.setText("刷新失败：" + err.getMessage() + "（自动重试）");
                        }
                    });
                } finally {
                    pollInFlight = false;
                }
            }
        });
    }

    private void loadOlder() {
        loadOlderButton.setEnabled(false);
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject result = NodeState.client.get("/api/v1/dsh/sessions/" + enc(sessionId)
                            + "/transcript?tail=1&offset=" + loadedCount + "&limit=" + PAGE);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            JSONArray messages = result.optJSONArray("messages");
                            int count = messages == null ? 0 : messages.length();
                            adapter.prepend(messages);
                            rememberSeqs(messages);
                            loadedCount += count;
                            totalCount = result.optLong("total", totalCount);
                            updateOlderButton();
                            loadOlderButton.setEnabled(true);
                            if (count == 0) statusView.setText("没有更早的消息了");
                        }
                    });
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            loadOlderButton.setEnabled(true);
                            Ui.showError(SessionActivity.this, err);
                        }
                    });
                }
            }
        });
    }

    private void send() {
        if (!canSend || sending) return;
        final String text = input.getText().toString().trim();
        if (text.isEmpty()) {
            Ui.toast(this, "请输入要发送的内容");
            return;
        }
        sending = true;
        sendButton.setEnabled(false);
        statusView.setText("正在发送…");
        final boolean steer = steerCheck.isChecked();
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject params = new JSONObject();
                    params.put("sessionId", sessionId);
                    params.put("text", text);
                    if (steer) params.put("mode", "steer");
                    JSONObject body = new JSONObject();
                    body.put("method", "sessions.prompt");
                    body.put("params", params);
                    body.put("waitSeconds", 20);
                    JSONObject result = NodeState.client.post("/api/v1/dsh/call", body);
                    String commandId = result.optString("commandId", "");
                    String state = result.optString("status", "");
                    if (result.optBoolean("pending", false) || "pending".equals(state) || "claimed".equals(state)) {
                        awaitCommand(commandId);
                    } else {
                        finishSend(result);
                    }
                } catch (final ApiException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            sending = false;
                            sendButton.setEnabled(true);
                            statusView.setText("发送失败");
                            Ui.showError(SessionActivity.this, err);
                        }
                    });
                } catch (final JSONException err) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            sending = false;
                            sendButton.setEnabled(true);
                            statusView.setText("参数错误");
                            Ui.toast(SessionActivity.this, "无法构造请求：" + err.getMessage());
                        }
                    });
                }
            }
        });
    }

    private void awaitCommand(String commandId) throws ApiException {
        long deadline = System.currentTimeMillis() + 120000;
        while (System.currentTimeMillis() < deadline) {
            JSONObject result = NodeState.client.get("/api/v1/dsh/call/" + enc(commandId));
            String state = result.optString("status", "");
            if ("done".equals(state) || "failed".equals(state) || "expired".equals(state)) {
                finishSend(result);
                return;
            }
            try {
                Thread.sleep(700);
            } catch (InterruptedException err) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                sending = false;
                sendButton.setEnabled(true);
                statusView.setText("命令仍在等待处理，可稍后刷新");
            }
        });
    }

    private void finishSend(JSONObject result) {
        final boolean ok = result.optBoolean("ok", false) && "done".equals(result.optString("status", "done"));
        final String errorText = errorText(result);
        main.post(new Runnable() {
            @Override
            public void run() {
                sending = false;
                sendButton.setEnabled(true);
                if (ok) {
                    input.setText("");
                    statusView.setText("已发送");
                    main.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            pollOnce();
                        }
                    }, 600);
                } else {
                    statusView.setText("发送失败");
                    Ui.toast(SessionActivity.this, errorText.isEmpty() ? "命令未成功" : errorText);
                }
            }
        });
    }

    private static String errorText(JSONObject result) {
        JSONObject error = result.optJSONObject("error");
        if (error != null) {
            String message = error.optString("message", error.optString("code", ""));
            if (!message.isEmpty()) return message;
        }
        String message = result.optString("error", "");
        return message;
    }

    private void rememberSeqs(JSONArray messages) {
        if (messages == null) return;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message == null) continue;
            long seq = message.optLong("seq", -1);
            if (seq > 0) seenSeq.add(seq);
        }
    }

    private void updateOlderButton() {
        boolean hasOlder = loadedCount < totalCount;
        loadOlderButton.setVisibility(hasOlder ? View.VISIBLE : View.GONE);
        loadOlderButton.setEnabled(hasOlder);
    }

    private void scrollToBottom() {
        if (adapter.getCount() > 0) listView.setSelection(adapter.getCount() - 1);
    }

    private static String enc(String value) {
        if (value == null) return "";
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException err) {
            return value;
        }
    }
}
