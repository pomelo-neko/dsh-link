package dev.dshlink.control;

import android.content.Context;
import android.graphics.Typeface;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Two-line rows: workspace title + path/session count. */
final class WorkspaceAdapter extends BaseAdapter {
    private final Context context;
    private final List<JSONObject> items = new ArrayList<>();

    WorkspaceAdapter(Context context) {
        this.context = context;
    }

    void setItems(JSONArray array) {
        items.clear();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) items.add(item);
            }
        }
        notifyDataSetChanged();
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
        JSONObject workspace = items.get(position);
        String title = workspace.optString("title", workspace.optString("id", "工作区"));
        if (title.isEmpty()) title = workspace.optString("id", "工作区");
        row.title.setText(title);
        StringBuilder sub = new StringBuilder();
        sub.append(workspace.optInt("sessions", 0)).append(" 个会话");
        String path = workspace.optString("path", "");
        if (!path.isEmpty()) sub.append(" · ").append(path);
        row.subtitle.setText(sub.toString());
        return row.container;
    }

    private static final class Row {
        final LinearLayout container;
        final TextView title;
        final TextView subtitle;

        Row(Context context) {
            container = new LinearLayout(context);
            container.setOrientation(LinearLayout.VERTICAL);
            container.setPadding(Ui.dp(context, 16), Ui.dp(context, 10), Ui.dp(context, 16), Ui.dp(context, 10));
            title = new TextView(context);
            title.setTextSize(16);
            title.setTextColor(0xFF17202A);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            subtitle = new TextView(context);
            subtitle.setTextSize(12);
            subtitle.setTextColor(0xFF6B7280);
            subtitle.setPadding(0, Ui.dp(context, 3), 0, 0);
            container.addView(title);
            container.addView(subtitle);
            container.setTag(this);
        }
    }
}
