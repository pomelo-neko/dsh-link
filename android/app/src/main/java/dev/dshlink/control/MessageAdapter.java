package dev.dshlink.control;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Layout;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.URLSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;

/**
 * Chat transcript renderer styled after the DeepSeek / DSH mobile apps:
 * user turns as right-aligned bubbles, assistant turns as full-width Markdown, and reasoning /
 * tool output as collapsed cards that expand on tap. Tool rows keep their previous grouping so a
 * long tool chain does not flood the screen.
 */
final class MessageAdapter extends BaseAdapter {
    private static final int MAX_BODY = 12000;
    private static final int MAX_GROUP_BODY = 40000;
    private static final int MAX_REASONING_BODY = 30000;
    private static final String MONO = "monospace";
    private static final int INK = 0xFF17202A;
    private static final int MUTED = 0xFF6B7280;
    private static final int BUBBLE = 0xFFE7F1FF;
    private static final int CARD = 0xFFF3F4F6;
    private static final int TOOL_FG = 0xFF37474F;
    private static final int TOOL_HEAD = 0xFF8A5A00;

    private final Context context;
    private final float density;
    private final List<JSONObject> items = new ArrayList<>();
    private final List<Object> rows = new ArrayList<>();
    private final Set<String> expanded = new HashSet<>();
    private final Map<String, CharSequence> markdownCache = new HashMap<>();
    private int bubbleMaxWidth;

    MessageAdapter(Context context) {
        this.context = context;
        this.density = context.getResources().getDisplayMetrics().density;
        this.bubbleMaxWidth = (int) (context.getResources().getDisplayMetrics().widthPixels * 0.80f);
    }

    // ---------------------------------------------------------------- data

    void clear() {
        items.clear();
        rows.clear();
        expanded.clear();
        markdownCache.clear();
        notifyDataSetChanged();
    }

    void setItems(JSONArray messages) {
        items.clear();
        expanded.clear();
        markdownCache.clear();
        appendAll(messages);
    }

    void append(JSONArray messages) {
        appendAll(messages);
    }

    void prepend(JSONArray messages) {
        if (messages == null) return;
        List<JSONObject> incoming = new ArrayList<>();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message != null) incoming.add(message);
        }
        if (incoming.isEmpty()) return;
        items.addAll(0, incoming);
        rebuild();
    }

    private void appendAll(JSONArray messages) {
        if (messages != null) {
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.optJSONObject(i);
                if (message != null) items.add(message);
            }
        }
        rebuild();
    }

    @Override
    public int getCount() {
        return rows.size();
    }

    @Override
    public Object getItem(int position) {
        return position >= 0 && position < rows.size() ? rows.get(position) : null;
    }

    @Override
    public long getItemId(int position) {
        Object row = getItem(position);
        if (row instanceof JSONObject) return ((JSONObject) row).optLong("seq", -1);
        return position;
    }

    private void rebuild() {
        rows.clear();
        List<JSONObject> pending = new ArrayList<>();
        for (JSONObject message : items) {
            if (isTool(message)) {
                pending.add(message);
                continue;
            }
            flushTools(pending);
            if ("reasoning".equals(kindOf(message))) {
                rows.add(new Reasoning(message));
            } else {
                rows.add(message);
            }
        }
        flushTools(pending);
        notifyDataSetChanged();
    }

    private void flushTools(List<JSONObject> pending) {
        if (pending.isEmpty()) return;
        rows.add(new Group(new ArrayList<>(pending)));
        pending.clear();
    }

    private boolean isTool(JSONObject message) {
        String kind = kindOf(message);
        return "tool-call".equals(kind) || "tool-result".equals(kind);
    }

    // ---------------------------------------------------------------- views

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        Object row = rows.get(position);
        if (row instanceof Group) return groupView((Group) row);
        if (row instanceof Reasoning) return reasoningView((Reasoning) row);
        return messageView((JSONObject) row);
    }

    private View messageView(JSONObject message) {
        String role = message.optString("role", "");
        String kind = kindOf(message);
        if ("system".equals(kind)) return systemView(message);
        if ("user".equals(role)) return userView(message);
        return assistantView(message);
    }

    private View userView(JSONObject message) {
        LinearLayout outer = new LinearLayout(context);
        outer.setOrientation(LinearLayout.HORIZONTAL);
        outer.setGravity(Gravity.END);
        int side = dp(12);
        outer.setPadding(dp(48), dp(5), side, dp(5));

        TextView body = markdownBody(textOf(message), 14.5f, INK);
        body.setBackground(rounded(BUBBLE, 16));
        body.setPadding(dp(12), dp(9), dp(12), dp(9));
        body.setMaxWidth(bubbleMaxWidth);
        attachCopy(body, textOf(message));
        outer.addView(body);
        return outer;
    }

    private View assistantView(JSONObject message) {
        LinearLayout outer = new LinearLayout(context);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setPadding(dp(14), dp(8), dp(14), dp(4));

        TextView header = new TextView(context);
        header.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        header.setTextColor(MUTED);
        header.setText(headerOf(message));
        outer.addView(header, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        String text = textOf(message);
        TextView body;
        if (text.trim().isEmpty()) {
            body = new TextView(context);
            body.setText("（无文本内容）");
            body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
            body.setTextColor(MUTED);
            body.setTypeface(Typeface.defaultFromStyle(Typeface.ITALIC));
        } else {
            body = markdownBody(text, 14.5f, INK);
            attachCopy(body, text);
        }
        body.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(5);
        outer.addView(body, params);
        return outer;
    }

    private View systemView(JSONObject message) {
        TextView body = new TextView(context);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        body.setTextColor(MUTED);
        body.setGravity(Gravity.CENTER);
        body.setPadding(dp(14), dp(6), dp(14), dp(6));
        body.setText(textOf(message));
        return body;
    }

    private View reasoningView(Reasoning reasoning) {
        boolean open = expanded.contains(reasoning.key());
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rounded(CARD, 12));
        card.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.leftMargin = dp(12);
        cardParams.rightMargin = dp(12);
        cardParams.topMargin = dp(4);
        cardParams.bottomMargin = dp(4);
        card.setLayoutParams(cardParams);

        String text = textOf(reasoning.message);
        TextView header = new TextView(context);
        header.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        header.setTextColor(MUTED);
        header.setTypeface(Typeface.MONOSPACE);
        String preview = text.replace('\n', ' ');
        if (preview.length() > 60) preview = preview.substring(0, 60) + "…";
        header.setText((open ? "▾ " : "▸ ") + "思考 · " + timeOf(reasoning.message)
                + (preview.isEmpty() ? "" : " · " + preview)
                + (open ? " · 点击收起" : " · 点击展开"));
        card.addView(header);

        if (open) {
            TextView body = new TextView(context);
            body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            body.setTextColor(MUTED);
            body.setText(truncate(text, MAX_REASONING_BODY));
            body.setPadding(0, dp(6), 0, 0);
            body.setLineSpacing(dp(2), 1f);
            body.setTextIsSelectable(true);
            card.addView(body);
        }
        card.setOnClickListener(v -> {
            String key = reasoning.key();
            if (!expanded.remove(key)) expanded.add(key);
            notifyDataSetChanged();
        });
        return card;
    }

    private View groupView(Group group) {
        boolean open = expanded.contains(group.key());
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rounded(CARD, 12));
        card.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.leftMargin = dp(12);
        cardParams.rightMargin = dp(12);
        cardParams.topMargin = dp(4);
        cardParams.bottomMargin = dp(4);
        card.setLayoutParams(cardParams);

        TextView header = new TextView(context);
        header.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        header.setTextColor(TOOL_HEAD);
        header.setTypeface(Typeface.MONOSPACE);
        header.setText(group.headerText(open));
        card.addView(header);

        TextView body = new TextView(context);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        body.setTextColor(TOOL_FG);
        body.setTypeface(Typeface.MONOSPACE);
        body.setText(group.bodyText(open, MAX_GROUP_BODY));
        body.setPadding(0, dp(6), 0, 0);
        body.setTextIsSelectable(open);
        card.addView(body);

        card.setOnClickListener(v -> {
            String key = group.key();
            if (!expanded.remove(key)) expanded.add(key);
            notifyDataSetChanged();
        });
        return card;
    }

    // ---------------------------------------------------------------- text helpers

    private TextView markdownBody(String text, float sp, int color) {
        TextView view = new TextView(context);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        CharSequence rendered = markdown(text);
        view.setText(rendered);
        if (rendered instanceof Spanned
                && ((Spanned) rendered).getSpans(0, rendered.length(), URLSpan.class).length > 0) {
            view.setMovementMethod(LinkMovementMethod.getInstance());
        }
        return view;
    }

    private CharSequence markdown(String text) {
        String key = Integer.toHexString(text.hashCode()) + ":" + text.length();
        CharSequence cached = markdownCache.get(key);
        if (cached != null) return cached;
        CharSequence rendered;
        try {
            rendered = ChatMarkdown.render(text, 14.5f);
        } catch (RuntimeException error) {
            rendered = new SpannableStringBuilder(text);
        }
        if (markdownCache.size() > 900) markdownCache.clear();
        markdownCache.put(key, rendered);
        return rendered;
    }

    private void attachCopy(TextView view, String raw) {
        if (raw == null || raw.isEmpty()) return;
        view.setOnLongClickListener(v -> {
            ClipboardManager clipboard =
                    (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) {
                clipboard.setPrimaryClip(ClipData.newPlainText("dsh-link", raw));
                Toast.makeText(context, "已复制全文", Toast.LENGTH_SHORT).show();
            }
            return true;
        });
    }

    private static String textOf(JSONObject message) {
        String text = message.optString("text", "");
        if (text.isEmpty()) text = message.optString("content", "");
        String tool = message.optString("tool", "");
        if (!tool.isEmpty() && ("tool-call".equals(kindOf(message)) || "tool-result".equals(kindOf(message)))) {
            text = text.isEmpty() ? ("tool: " + tool) : text + "\n\ntool: " + tool;
        }
        return truncate(text, MAX_BODY);
    }

    private static String kindOf(JSONObject message) {
        return message.optString("kind", "");
    }

    private static String roleOf(JSONObject message) {
        return message.optString("role", "");
    }

    private static String labelOf(JSONObject message) {
        String kind = kindOf(message);
        if ("reasoning".equals(kind)) return "思考";
        if ("tool-call".equals(kind)) return "工具调用";
        if ("tool-result".equals(kind)) return "工具结果";
        String role = roleOf(message);
        if ("user".equals(role)) return "用户";
        if ("assistant".equals(role)) return "DSH";
        return "系统";
    }

    private static String headerOf(JSONObject message) {
        StringBuilder builder = new StringBuilder();
        long seq = message.optLong("seq", -1);
        if (seq > 0) builder.append('#').append(seq).append(" · ");
        builder.append(labelOf(message));
        String tool = message.optString("tool", "");
        if (!tool.isEmpty()) builder.append(" · ").append(tool);
        String time = timeOf(message);
        if (!time.isEmpty()) builder.append(" · ").append(time);
        return builder.toString();
    }

    private static String timeOf(JSONObject message) {
        // Transcript frames carry epoch millis in "time"; other endpoints use ISO strings.
        long epoch = message.optLong("time", -1);
        if (epoch > 0) {
            return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(epoch));
        }
        String stamp = message.optString("ts", message.optString("createdAt", ""));
        if (stamp.length() >= 16 && stamp.charAt(10) == 'T') {
            return stamp.substring(11, 16);
        }
        return "";
    }

    private static String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max) + "\n…（已截断，共 " + text.length() + " 字符）";
    }

    private int dp(int value) {
        return (int) (value * density + 0.5f);
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radiusDp * density);
        return drawable;
    }

    // ---------------------------------------------------------------- row model

    private static final class Reasoning {
        final JSONObject message;
        private final String key;

        Reasoning(JSONObject message) {
            this.message = message;
            long seq = message.optLong("seq", -1);
            String text = textOf(message);
            this.key = "r:" + seq + ":" + Integer.toHexString(text.hashCode());
        }

        String key() {
            return key;
        }
    }

    private static final class Group {
        final List<JSONObject> messages;
        private final String key;

        Group(List<JSONObject> messages) {
            this.messages = messages;
            JSONObject first = messages.get(0);
            JSONObject last = messages.get(messages.size() - 1);
            this.key = "g:" + first.optLong("seq", -1) + ":" + last.optLong("seq", -1)
                    + ":" + messages.size();
        }

        String key() {
            return key;
        }

        String headerText(boolean open) {
            StringBuilder builder = new StringBuilder();
            JSONObject first = messages.get(0);
            long seq = first.optLong("seq", -1);
            if (seq > 0) builder.append('#').append(seq).append(" · ");
            builder.append("工具调用 · ").append(messages.size()).append(" 条");
            String time = timeOf(first);
            if (!time.isEmpty()) builder.append(" · ").append(time);
            builder.append(open ? " · 点击收起" : " · 点击展开");
            return builder.toString();
        }

        String bodyText(boolean open, int max) {
            if (!open) {
                StringBuilder names = new StringBuilder();
                for (JSONObject message : messages) {
                    String name = message.optString("tool", "");
                    if (name.isEmpty()) name = "工具";
                    if (names.length() > 0) names.append("，");
                    names.append(name);
                }
                return names + "（已折叠，点击展开）";
            }
            StringBuilder builder = new StringBuilder();
            for (JSONObject message : messages) {
                if (builder.length() > 0) builder.append("\n\n");
                builder.append(headerOf(message)).append('\n').append(textOf(message));
                if (builder.length() > max) {
                    builder.append("\n…（已截断）");
                    break;
                }
            }
            return builder.toString();
        }
    }
}
