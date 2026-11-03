package dev.dshlink.control;

import android.content.Context;
import android.graphics.Color;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Transcript rows: role/kind header plus selectable body text. */
final class MessageAdapter extends BaseAdapter {
    private static final int MAX_BODY = 12000;

    private final Context context;
    private final List<JSONObject> items = new ArrayList<>();

    MessageAdapter(Context context) {
        this.context = context;
    }

    void clear() {
        items.clear();
        notifyDataSetChanged();
    }

    void setItems(JSONArray array) {
        items.clear();
        addArray(array);
        notifyDataSetChanged();
    }

    void append(JSONArray array) {
        if (array == null || array.length() == 0) return;
        addArray(array);
        notifyDataSetChanged();
    }

    void prepend(JSONArray array) {
        if (array == null || array.length() == 0) return;
        List<JSONObject> older = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) older.add(item);
        }
        items.addAll(0, older);
        notifyDataSetChanged();
    }

    private void addArray(JSONArray array) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null) items.add(item);
        }
    }

    @Override
    public int getCount() {
        return items.size();
    }

    @Override
    public JSONObject getItem(int position) {
        return items.get(position);
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        Row row;
        if (convertView instanceof LinearLayout && convertView.getTag() instanceof Row) {
            row = (Row) convertView.getTag();
        } else {
            row = new Row(context);
        }
        JSONObject message = items.get(position);
        String kind = message.optString("kind", "assistant");
        row.header.setText(headerOf(message, kind));
        row.header.setTextColor(colorOf(kind));
        String text = message.optString("text", "");
        if (text.isEmpty()) text = "（无文本内容）";
        if (text.length() > MAX_BODY) text = text.substring(0, MAX_BODY) + "\n…（本机仅显示前 " + MAX_BODY + " 个字符）";
        row.body.setText(text);
        boolean hasTool = !TextUtils.isEmpty(message.optString("tool", ""));
        if (hasTool) {
            row.body.append("\n\ntool: " + message.optString("tool"));
        }
        if (message.optBoolean("truncated", false)) {
            row.body.append("\n（内容在节点侧按长度截断）");
        }
        return row.container;
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
