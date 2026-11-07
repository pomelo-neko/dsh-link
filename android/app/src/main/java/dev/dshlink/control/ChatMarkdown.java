package dev.dshlink.control;

import android.graphics.Color;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.URLSpan;
import android.text.style.UnderlineSpan;

import java.util.List;

/**
 * Turns the dependency-free {@link Markdown} blocks into a Spannable for chat bubbles.
 *
 * Assistant output is Markdown, so headings, lists, fenced code, quotes, tables and inline
 * emphasis/links/code are rendered instead of showing raw "**" markers. Code and table rows use the
 * monospace face; table columns are padded by display width so CJK text stays aligned.
 */
final class ChatMarkdown {
    private static final String MONOSPACE = "monospace";
    private static final int CODE_BG = 0xFFF1F3F5;
    private static final int LINK_FG = 0xFF1A73E8;
    private static final int QUOTE_FG = 0xFF6B7280;

    private ChatMarkdown() {
    }

    static CharSequence render(String markdown, float textSizeSp) {
        List<Markdown.Block> blocks = Markdown.parse(markdown == null ? "" : markdown);
        SpannableStringBuilder out = new SpannableStringBuilder();
        boolean first = true;
        int index = 0;
        while (index < blocks.size()) {
            Markdown.Block block = blocks.get(index);
            if (block.type == Markdown.BLOCK_TABLE_ROW) {
                int end = index;
                int columns = 0;
                while (end < blocks.size() && blocks.get(end).type == Markdown.BLOCK_TABLE_ROW) {
                    columns = Math.max(columns, blocks.get(end).cells.size());
                    end++;
                }
                int[] widths = new int[columns];
                for (int row = index; row < end; row++) {
                    List<String> cells = blocks.get(row).cells;
                    for (int column = 0; column < cells.size(); column++) {
                        widths[column] = Math.max(widths[column],
                                displayWidth(plainText(cells.get(column))));
                    }
                }
                for (int row = index; row < end; row++) {
                    if (!first) out.append('\n');
                    first = false;
                    appendTableRow(out, blocks.get(row).cells, widths);
                }
                index = end;
                continue;
            }
            index++;
            if (block.type == Markdown.BLOCK_EMPTY) continue;
            if (!first) out.append('\n');
            first = false;
            switch (block.type) {
                case Markdown.BLOCK_HEADING: {
                    int start = out.length();
                    appendInline(out, block.inlines);
                    int finish = out.length();
                    if (finish > start) {
                        out.setSpan(new StyleSpan(Typeface.BOLD), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new RelativeSizeSpan(headingScale(block.level)), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    }
                    break;
                }
                case Markdown.BLOCK_CODE: {
                    int start = out.length();
                    out.append(block.text == null ? "" : block.text);
                    int finish = out.length();
                    if (finish > start) {
                        out.setSpan(new TypefaceSpan(MONOSPACE), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new BackgroundColorSpan(CODE_BG), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    }
                    break;
                }
                case Markdown.BLOCK_LIST_ITEM: {
                    if (block.ordered) {
                        int number = block.level > 0 ? block.level : 1;
                        out.append(String.valueOf(number)).append(". ");
                    } else {
                        out.append("\u2022 ");
                    }
                    appendInline(out, block.inlines);
                    break;
                }
                case Markdown.BLOCK_QUOTE: {
                    int start = out.length();
                    out.append("\u258E ");
                    appendInline(out, block.inlines);
                    int finish = out.length();
                    if (finish > start) {
                        out.setSpan(new ForegroundColorSpan(QUOTE_FG), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new StyleSpan(Typeface.ITALIC), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    }
                    break;
                }
                default:
                    appendInline(out, block.inlines);
                    break;
            }
        }
        return out;
    }

    private static void appendInline(SpannableStringBuilder out, List<Markdown.Inline> inlines) {
        if (inlines == null) return;
        for (Markdown.Inline inline : inlines) {
            if (inline == null || inline.text == null) continue;
            int start = out.length();
            out.append(inline.text);
            int finish = out.length();
            if (finish <= start || inline.style == Markdown.Inline.STYLE_NORMAL) continue;
            switch (inline.style) {
                case Markdown.Inline.STYLE_BOLD:
                    out.setSpan(new StyleSpan(Typeface.BOLD), start, finish,
                            SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    break;
                case Markdown.Inline.STYLE_ITALIC:
                    out.setSpan(new StyleSpan(Typeface.ITALIC), start, finish,
                            SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    break;
                case Markdown.Inline.STYLE_STRIKE:
                    out.setSpan(new StrikethroughSpan(), start, finish,
                            SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    break;
                case Markdown.Inline.STYLE_CODE:
                    out.setSpan(new TypefaceSpan(MONOSPACE), start, finish,
                            SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new BackgroundColorSpan(CODE_BG), start, finish,
                            SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    break;
                case Markdown.Inline.STYLE_LINK:
                    if (inline.url != null && !inline.url.isEmpty()) {
                        out.setSpan(new URLSpan(inline.url), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new UnderlineSpan(), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new ForegroundColorSpan(LINK_FG), start, finish,
                                SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
                    }
                    break;
                default:
                    break;
            }
        }
    }

    private static void appendTableRow(SpannableStringBuilder out, List<String> cells, int[] widths) {
        int start = out.length();
        for (int column = 0; column < cells.size(); column++) {
            if (column > 0) out.append("  ");
            // Table cells carry their own inline markup: render it instead of showing literal
            // backticks/brackets, and pad by the plain width so columns stay aligned.
            String cell = cells.get(column);
            appendInline(out, Markdown.parseInline(cell));
            int pad = column < widths.length ? widths[column] - displayWidth(plainText(cell)) : 0;
            for (int i = 0; i < pad; i++) out.append(' ');
        }
        int finish = out.length();
        if (finish > start) {
            out.setSpan(new TypefaceSpan(MONOSPACE), start, finish,
                    SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }

    /** Inline runs with the markup removed, used to measure table column widths. */
    private static String plainText(String cell) {
        StringBuilder text = new StringBuilder();
        for (Markdown.Inline inline : Markdown.parseInline(cell)) {
            if (inline != null && inline.text != null) text.append(inline.text);
        }
        return text.toString();
    }

    private static float headingScale(int level) {
        if (level <= 1) return 1.32f;
        if (level == 2) return 1.2f;
        if (level == 3) return 1.12f;
        return 1.06f;
    }

    /** Terminal-ish width: CJK and other wide code points count as two columns. */
    static int displayWidth(String text) {
        if (text == null) return 0;
        int width = 0;
        for (int i = 0; i < text.length(); ) {
            int codePoint = text.codePointAt(i);
            i += Character.charCount(codePoint);
            width += isWide(codePoint) ? 2 : 1;
        }
        return width;
    }

    private static boolean isWide(int codePoint) {
        return (codePoint >= 0x1100 && codePoint <= 0x115F)
                || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
                || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
                || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
                || (codePoint >= 0xFE30 && codePoint <= 0xFE4F)
                || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
                || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
                || (codePoint >= 0x20000 && codePoint <= 0x3FFFD);
    }

    static int color(int value) {
        return Color.argb(Color.alpha(value), Color.red(value), Color.green(value), Color.blue(value));
    }
}
