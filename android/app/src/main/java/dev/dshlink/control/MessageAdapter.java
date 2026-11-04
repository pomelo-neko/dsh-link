package dev.dshlink.control;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Transcript rows: role/kind header plus selectable body text.
 *
 * Consecutive tool-call / tool-result rows are folded into one collapsed row so a long agent turn
 * stays readable. Tapping that row expands it; the expanded state survives transcript refreshes.
 */
final class MessageAdapter extends BaseAdapter {
    private static final int MAX_BODY = 12000;
    private static final int MAX_GROUP_BODY = 40000;

    private final Context context;
    /** Raw messages in transcript order. */
    private final List<JSONObject> items = new ArrayList<>();
    /** Display rows: a JSONObject, or a Group for folded tool traffic. */
    private final List<Object> rows = new ArrayList<>();
    private final Set<String> expanded = new HashSet<>();

    MessageAdapter(Context context) {
        this.context = context;
    }

    void clear() {
        items.clear();
        rebuild();
    }

    void setItems(JSONArray array) {
        items.clear();
        addArray(array);
        rebuild();
    }

    void append(JSONArray array) {
        if (array == null || array.length() == 0) return;
        addArray(array);
        rebuild();
    }

    void prepend(JSONArray array) {
        if (array == null || array.length() == 0) return;
        List<JSONObject> older = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) older.add(item);
        }
        items.addAll(0, older);
        rebuild();
    }

    private void addArray(JSONArray array) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) items.add(item);
        }
    }

    private void rebuild() {
        rows.clear();
        Group current = null;
        for (JSONObject message : items) {
            if (isTool(message)) {
                if (current == null) {
                    current = new Group();
                    rows.add(current);
                }
                current.messages.add(message);
            } else {
                current = null;
                rows.add(message);
            }
        }
        notifyDataSetChanged();
    }

    private static boolean isTool(JSONObject message) {
        String kind = Ui.text(message, "kind");
        return "tool-call".equals(kind) || "tool-result".equals(kind);
    }

    @Override
    public int getCount() {
        return rows.size();
    }

    @Override
    public Object getItem(int position) {
        return rows.get(position);
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        Object entry = rows.get(position);
        if (entry instanceof Group) return groupView((Group) entry);
        Row row;
        if (convertView instanceof LinearLayout && convertView.getTag() instanceof Row) {
            row = (Row) convertView.getTag();
        } else {
            row = new Row(context);
        }
        JSONObject message = (JSONObject) entry;
        String kind = Ui.text(message, "kind");
        if (kind.isEmpty()) kind = "assistant";
        row.header.setText(headerOf(message, kind));
        row.header.setTextColor(colorOf(kind));
        row.body.setText(bodyOf(message));
        return row.container;
    }

    /** A collapsed run of tool-call/tool-result rows. */
    private View groupView(final Group group) {
        final String key = group.key();
        boolean open = expanded.contains(key);
        LinearLayout container = new LinearLayout(context);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(Ui.dp(context, 14), Ui.dp(context, 8), Ui.dp(context, 14), Ui.dp(context, 8));

        TextView header = new TextView(context);
        header.setTextSize(12);
        header.setTypeface(Typeface.MONOSPACE);
        header.setTextColor(0xFFE65100);
        header.setText(group.headerText(open));

        TextView body = new TextView(context);
        body.setTextSize(13);
        body.setTextColor(0xFF37474F);
        body.setTextIsSelectable(true);
        body.setLineSpacing(0f, 1.1f);
        body.setPadding(0, Ui.dp(context, 4), 0, 0);
        body.setText(group.bodyText(open, MAX_GROUP_BODY));

        container.addView(header);
        container.addView(body);
        container.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (!expanded.remove(key)) expanded.add(key);
                notifyDataSetChanged();
            }
        });
        return container;
    }

    private static String bodyOf(JSONObject message) {
        String text = Ui.text(message, "text");
        if (text.isEmpty()) text = "（无文本内容）";
        if (text.length() > MAX_BODY) {
            text = text.substring(0, MAX_BODY) + "\n…（本机仅显示前 " + MAX_BODY + " 个字符）";
        }
        StringBuilder body = new StringBuilder(text);
        String tool = Ui.text(message, "tool");
        if (!TextUtils.isEmpty(tool)) body.append("\n\ntool: ").append(tool);
        if (message.optBoolean("truncated", false)) {
            body.append("\n（内容在节点侧按长度截断）");
        }
        return body.toString();
    }

    private static String headerOf(JSONObject message, String kind) {
        StringBuilder header = new StringBuilder();
        int seq = message.optInt("seq", -1);
        if (seq > 0) header.append("#").append(seq).append(" · ");
        header.append(labelOf(kind));
        Object rawTime = message.opt("time");
        if (rawTime instanceof Number) {
            String clock = Ui.clock(((Number) rawTime).longValue());
            if (!clock.isEmpty()) header.append(" · ").append(clock);
        } else if (rawTime != null) {
            String time = String.valueOf(rawTime);
            if (time.length() >= 19) header.append(" · ").append(time, 11, 19);
            else if (!time.isEmpty()) header.append(" · ").append(time);
        }
        return header.toString();
    }

    private static String labelOf(String kind) {
        if ("user".equals(kind)) return "用户";
        if ("assistant".equals(kind)) return "DSH";
        if ("reasoning".equals(kind)) return "思考";
        if ("tool-call".equals(kind)) return "工具调用";
        if ("tool-result".equals(kind)) return "工具结果";
        if ("system".equals(kind)) return "系统";
        return kind;
    }

    private static int colorOf(String kind) {
        if ("user".equals(kind)) return 0xFF0D47A1;
        if ("assistant".equals(kind)) return 0xFF1B5E20;
        if ("reasoning".equals(kind)) return 0xFF6A1B9A;
        if ("tool-call".equals(kind)) return 0xFFE65100;
        if ("tool-result".equals(kind)) return 0xFF37474F;
        if ("system".equals(kind)) return 0xFF616161;
        return Color.DKGRAY;
    }

    private static final class Group {
        final List<JSONObject> messages = new ArrayList<>();

        JSONObject first() {
            return messages.get(0);
        }

        String key() {
            JSONObject first = first();
            return first.optLong("seq", -1) + ":" + messages.size() + ":"
                    + Integer.toHexString(Ui.text(first, "text").hashCode());
        }

        String tools() {
            Set<String> names = new LinkedHashSet<>();
            for (JSONObject message : messages) {
                String tool = Ui.text(message, "tool");
                if (!tool.isEmpty()) names.add(tool);
            }
            if (names.isEmpty()) return "工具";
            StringBuilder joined = new StringBuilder();
            int count = 0;
            for (String name : names) {
                if (count >= 3) {
                    joined.append("…");
                    break;
                }
                if (count > 0) joined.append(", ");
                joined.append(name);
                count++;
            }
            return joined.toString();
        }

        String headerText(boolean open) {
            int seq = first().optInt("seq", -1);
            StringBuilder header = new StringBuilder();
            if (seq > 0) header.append("#").append(seq).append(" · ");
            header.append("工具调用 · ").append(messages.size()).append(" 条");
            Object rawTime = first().opt("time");
            if (rawTime instanceof Number) {
                String clock = Ui.clock(((Number) rawTime).longValue());
                if (!clock.isEmpty()) header.append(" · ").append(clock);
            } else if (rawTime != null) {
                String time = String.valueOf(rawTime);
                if (time.length() >= 19) header.append(" · ").append(time, 11, 19);
            }
            header.append(open ? " · 点击收起" : " · 点击展开");
            return header.toString();
        }

        String bodyText(boolean open, int max) {
            if (!open) return tools() + "（已折叠，点击展开）";
            StringBuilder body = new StringBuilder();
            for (JSONObject message : messages) {
                if (body.length() > max) {
                    body.append("\n…（折叠内容过长，本机仅显示前 ").append(max).append(" 个字符）");
                    break;
                }
                String kind = Ui.text(message, "kind");
                if (kind.isEmpty()) kind = "tool-call";
                body.append(headerOf(message, kind)).append("\n");
                body.append(bodyOf(message)).append("\n\n");
            }
            return body.toString().trim();
        }
    }

    private static final class Row {
        final LinearLayout container;
        final TextView header;
        final TextView body;

        Row(Context context) {
            container = new LinearLayout(context);
            container.setOrientation(LinearLayout.VERTICAL);
            container.setPadding(Ui.dp(context, 14), Ui.dp(context, 8), Ui.dp(context, 14), Ui.dp(context, 8));
            header = new TextView(context);
            header.setTextSize(11);
            header.setTypeface(android.graphics.Typeface.MONOSPACE);
            body = new TextView(context);
            body.setTextSize(14);
            body.setTextColor(0xFF17202A);
            body.setTextIsSelectable(true);
            body.setPadding(0, Ui.dp(context, 4), 0, 0);
            body.setLineSpacing(0f, 1.1f);
            container.addView(header);
            container.addView(body);
            container.setTag(this);
        }
    }
}
