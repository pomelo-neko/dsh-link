package dev.dshlink.control;

import java.util.ArrayList;
import java.util.Collections;

/**
 * Pragmatic Markdown parser for chat transcripts.
 *
 * <p>Handles the block and inline shapes a model answer actually uses: fenced code, ATX headings,
 * bullet/ordered list items, quotes, simple pipe tables and paragraphs, plus bold, italic, strike,
 * inline code, links and backslash escapes inside them. This is deliberately not CommonMark - the
 * output is deterministic, allocation-light and safe to run on the UI thread.
 *
 * <p>Contract for callers:
 * <ul>
 *   <li>Neither entry point returns null and no element is ever null.</li>
 *   <li>Blocks are returned in document order, inline segments in reading order. Adjacent segments
 *       that share a style (and link target) are merged into one {@link Inline}.</li>
 *   <li>{@link Inline#url} is non-null only for {@link Inline#STYLE_LINK}.</li>
 *   <li>Blank source lines produce {@link #BLOCK_EMPTY}; one trailing newline does not.</li>
 *   <li>Malformed markup is preserved as literal text; no input makes the parser throw.</li>
 * </ul>
 */
public final class Markdown {

    public static final int BLOCK_PARAGRAPH = 0;
    public static final int BLOCK_HEADING = 1;
    public static final int BLOCK_CODE = 2;
    public static final int BLOCK_LIST_ITEM = 3;
    public static final int BLOCK_QUOTE = 4;
    public static final int BLOCK_TABLE_ROW = 5;
    public static final int BLOCK_EMPTY = 6;

    /**
     * Depth cap for inline recursion. Emphasis is flattened to one style per segment, so this is a
     * safety valve for adversarial input rather than a formatting feature.
     */
    private static final int MAX_INLINE_DEPTH = 8;

    private Markdown() {
    }

    /** A run of inline text that shares one style (and, for links, one target). */
    public static final class Inline {

        public static final int STYLE_NORMAL = 0;
        public static final int STYLE_BOLD = 1;
        public static final int STYLE_ITALIC = 2;
        public static final int STYLE_STRIKE = 3;
        public static final int STYLE_CODE = 4;
        public static final int STYLE_LINK = 5;

        /** Visible text; never null. */
        public final String text;

        /** One of the {@code STYLE_*} constants. */
        public final int style;

        /** Link target; non-null only for {@link #STYLE_LINK}. */
        public final String url;

        public Inline(String text, int style, String url) {
            this.text = text == null ? "" : text;
            this.style = style;
            this.url = url;
        }
    }

    /** One rendered block of a transcript message. */
    public static final class Block {

        /** One of the {@code BLOCK_*} constants. */
        public final int type;

        /**
         * Heading level 1..6 for {@link #BLOCK_HEADING}; ordered-list number for an ordered
         * {@link #BLOCK_LIST_ITEM}; 0 everywhere else.
         */
        public final int level;

        /** True for an ordered {@link #BLOCK_LIST_ITEM}. */
        public final boolean ordered;

        /** Code fence info string ("" when absent); never null. */
        public final String language;

        /**
         * Code content for {@link #BLOCK_CODE}, plain text for paragraphs/headings/quotes/list
         * items, and "" for empty or table-row blocks (table rows carry {@link #cells}).
         */
        public final String text;

        /** Parsed inline runs; empty for code, table and empty blocks. Never null. */
        public final java.util.List<Inline> inlines;

        /** Table cells for {@link #BLOCK_TABLE_ROW}; empty otherwise. Never null. */
        public final java.util.List<String> cells;

        public Block(int type, int level, boolean ordered, String language, String text,
                java.util.List<Inline> inlines, java.util.List<String> cells) {
            this.type = type;
            this.level = level;
            this.ordered = ordered;
            this.language = language == null ? "" : language;
            this.text = text == null ? "" : text;
            this.inlines = inlines == null ? Collections.<Inline>emptyList() : inlines;
            this.cells = cells == null ? Collections.<String>emptyList() : cells;
        }

        /** Convenience constructor for blocks that have no table cells. */
        public Block(int type, int level, boolean ordered, String language, String text,
                java.util.List<Inline> inlines) {
            this(type, level, ordered, language, text, inlines, null);
        }

        /** Convenience constructor for blocks that have no inline content. */
        public Block(int type, int level, boolean ordered, String language, String text) {
            this(type, level, ordered, language, text, null, null);
        }
    }

    /**
     * Parses a message body into blocks in document order. A blank line becomes a
     * {@link #BLOCK_EMPTY} block; a single trailing newline does not create one. CRLF and lone CR
     * are normalised to LF, and leading tabs count as four spaces.
     *
     * @param markdown source text; null or empty yields an empty list
     * @return mutable list owned by the caller, never null
     */
    public static java.util.List<Block> parse(String markdown) {
        java.util.List<Block> blocks = new ArrayList<>();
        if (markdown == null || markdown.isEmpty()) return blocks;
        String normalized = markdown.replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = normalized.split("\n", -1);
        int count = lines.length;
        if (count > 0 && lines[count - 1].isEmpty()) count--;
        int i = 0;
        while (i < count) {
            String line = expandLeadingTabs(lines[i]);
            if (isBlank(line)) {
                blocks.add(new Block(BLOCK_EMPTY, 0, false, "", "", null, null));
                i++;
                continue;
            }
            Fence fence = fenceOf(line);
            if (fence != null) {
                i++;
                StringBuilder code = new StringBuilder();
                boolean first = true;
                while (i < count) {
                    String content = expandLeadingTabs(lines[i]);
                    if (isClosingFence(content, fence)) {
                        i++;
                        break;
                    }
                    if (!first) code.append('\n');
                    code.append(content);
                    first = false;
                    i++;
                }
                blocks.add(new Block(BLOCK_CODE, 0, false, fence.info, code.toString(), null, null));
                continue;
            }
            Heading heading = headingOf(line);
            if (heading != null) {
                blocks.add(new Block(BLOCK_HEADING, heading.level, false, "", heading.text,
                        parseInline(heading.text), null));
                i++;
                continue;
            }
            if (isQuote(line)) {
                String text = stripQuote(line);
                blocks.add(new Block(BLOCK_QUOTE, 0, false, "", text, parseInline(text), null));
                i++;
                continue;
            }
            ListItem item = listItemOf(line);
            if (item != null) {
                blocks.add(new Block(BLOCK_LIST_ITEM, item.level, item.ordered, "", item.text,
                        parseInline(item.text), null));
                i++;
                continue;
            }
            java.util.List<String> cells = tableCells(line);
            if (cells != null) {
                if (!isSeparatorRow(cells)) {
                    blocks.add(new Block(BLOCK_TABLE_ROW, 0, false, "", "", null, cells));
                }
                i++;
                continue;
            }
            StringBuilder paragraph = new StringBuilder(line);
            i++;
            while (i < count) {
                String next = expandLeadingTabs(lines[i]);
                if (startsBlock(next)) break;
                paragraph.append('\n').append(next);
                i++;
            }
            String text = paragraph.toString();
            blocks.add(new Block(BLOCK_PARAGRAPH, 0, false, "", text, parseInline(text), null));
        }
        return blocks;
    }

    /**
     * Parses inline markup into styled runs in reading order. Bold, italic, strike, inline code and
     * links are recognised; emphasis nested inside emphasis is flattened to the innermost style.
     * Unmatched markers stay literal.
     *
     * @param text source text; null or empty yields an empty list
     * @return mutable list owned by the caller, never null
     */
    public static java.util.List<Inline> parseInline(String text) {
        java.util.List<Inline> inlines = new ArrayList<>();
        if (text == null || text.isEmpty()) return inlines;
        Sink sink = new Sink(inlines);
        new InlineParser(text, sink).parse(0, text.length(), Inline.STYLE_NORMAL, null, 0);
        sink.flush();
        return inlines;
    }

    /** Normalises leading tabs (only at the start of a line) to four spaces each. */
    private static String expandLeadingTabs(String line) {
        int length = line.length();
        int i = 0;
        boolean tab = false;
        while (i < length) {
            char c = line.charAt(i);
            if (c == '\t') {
                tab = true;
                i++;
            } else if (c == ' ') {
                i++;
            } else {
                break;
            }
        }
        if (!tab) return line;
        StringBuilder expanded = new StringBuilder(length + 8);
        for (int j = 0; j < i; j++) {
            expanded.append(line.charAt(j) == '\t' ? "    " : " ");
        }
        expanded.append(line, i, length);
        return expanded.toString();
    }

    private static boolean isBlank(String line) {
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c != ' ' && c != '\t') return false;
        }
        return true;
    }

    /** A fenced-code opener: three or more backticks or tildes, plus the trimmed info string. */
    private static Fence fenceOf(String line) {
        String trimmed = line.trim();
        if (trimmed.length() < 3) return null;
        char marker = trimmed.charAt(0);
        if (marker != '`' && marker != '~') return null;
        int fenceLength = 0;
        while (fenceLength < trimmed.length() && trimmed.charAt(fenceLength) == marker) {
            fenceLength++;
        }
        if (fenceLength < 3) return null;
        return new Fence(marker, fenceLength, trimmed.substring(fenceLength).trim());
    }

    private static boolean isClosingFence(String line, Fence fence) {
        String trimmed = line.trim();
        if (trimmed.length() < fence.length) return false;
        if (trimmed.charAt(0) != fence.marker) return false;
        int run = 0;
        while (run < trimmed.length() && trimmed.charAt(run) == fence.marker) run++;
        return run >= fence.length;
    }

    private static boolean startsBlock(String line) {
        if (isBlank(line)) return true;
        if (fenceOf(line) != null) return true;
        if (headingOf(line) != null) return true;
        if (isQuote(line)) return true;
        if (listItemOf(line) != null) return true;
        return tableCells(line) != null;
    }

    /** ATX heading: up to three leading spaces, 1..6 '#' followed by a space or end of line. */
    private static Heading headingOf(String line) {
        int length = line.length();
        int i = 0;
        while (i < length && line.charAt(i) == ' ') i++;
        if (i > 3) return null;
        int start = i;
        while (i < length && line.charAt(i) == '#') i++;
        int level = i - start;
        if (level < 1 || level > 6) return null;
        if (i < length && line.charAt(i) != ' ') return null;
        String text = i < length ? line.substring(i + 1) : "";
        text = text.trim();
        int end = text.length();
        int hashes = end;
        while (hashes > 0 && text.charAt(hashes - 1) == '#') hashes--;
        if (hashes < end && (hashes == 0 || text.charAt(hashes - 1) == ' ')) {
            text = text.substring(0, hashes).trim();
        }
        return new Heading(level, text);
    }

    private static boolean isQuote(String line) {
        int i = 0;
        while (i < line.length() && line.charAt(i) == ' ') i++;
        return i < line.length() && line.charAt(i) == '>';
    }

    private static String stripQuote(String line) {
        int i = 0;
        while (i < line.length() && line.charAt(i) == ' ') i++;
        i++;
        if (i < line.length() && line.charAt(i) == ' ') i++;
        return line.substring(i);
    }

    /** Bullet ("- ", "* ", "+ ") or ordered ("12. ") list item at the start of the line. */
    private static ListItem listItemOf(String line) {
        int length = line.length();
        int i = 0;
        while (i < length && line.charAt(i) == ' ') i++;
        if (i + 1 < length) {
            char marker = line.charAt(i);
            if ((marker == '-' || marker == '*' || marker == '+') && line.charAt(i + 1) == ' ') {
                return new ListItem(false, 0, line.substring(i + 2));
            }
        }
        int digits = 0;
        while (i + digits < length && isDigit(line.charAt(i + digits))) digits++;
        if (digits > 0 && i + digits + 1 < length && line.charAt(i + digits) == '.'
                && line.charAt(i + digits + 1) == ' ') {
            int number = parseListNumber(line.substring(i, i + digits));
            return new ListItem(true, number, line.substring(i + digits + 2));
        }
        return null;
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    /** Clamps an ordered-list marker to 1..9999; absurdly long numbers clamp instead of throwing. */
    private static int parseListNumber(String digits) {
        int value;
        try {
            value = Integer.parseInt(digits);
        } catch (NumberFormatException e) {
            return 9999;
        }
        if (value < 1) return 1;
        if (value > 9999) return 9999;
        return value;
    }

    /**
     * Splits a table-row line into trimmed cells. Returns null when the line has no '|' or yields
     * fewer than two cells. Border pipes are dropped, '\|' is unescaped, separator rows are
     * returned as-is (the caller skips them).
     */
    private static java.util.List<String> tableCells(String line) {
        if (line.indexOf('|') < 0) return null;
        String trimmed = line.trim();
        java.util.List<String> cells = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (c == '\\' && i + 1 < trimmed.length() && trimmed.charAt(i + 1) == '|') {
                cell.append('|');
                i++;
            } else if (c == '|') {
                cells.add(cell.toString());
                cell.setLength(0);
            } else {
                cell.append(c);
            }
        }
        cells.add(cell.toString());
        if (trimmed.startsWith("|") && !cells.isEmpty() && cells.get(0).trim().isEmpty()) {
            cells.remove(0);
        }
        int last = cells.size() - 1;
        if (trimmed.endsWith("|") && last >= 0 && cells.get(last).trim().isEmpty()) {
            cells.remove(last);
        }
        if (cells.size() < 2) return null;
        for (int i = 0; i < cells.size(); i++) cells.set(i, cells.get(i).trim());
        return cells;
    }

    /** True when every cell looks like a table separator (---, :---, ---:, :---:). */
    private static boolean isSeparatorRow(java.util.List<String> cells) {
        if (cells.isEmpty()) return false;
        for (int i = 0; i < cells.size(); i++) {
            if (!isSeparatorCell(cells.get(i))) return false;
        }
        return true;
    }

    private static boolean isSeparatorCell(String cell) {
        int length = cell.length();
        if (length == 0) return false;
        int i = 0;
        if (cell.charAt(0) == ':') i++;
        int dashes = 0;
        while (i < length && cell.charAt(i) == '-') {
            i++;
            dashes++;
        }
        if (dashes == 0) return false;
        if (i < length && cell.charAt(i) == ':') i++;
        return i == length;
    }

    private static boolean isWordChar(char c) {
        return Character.isLetterOrDigit(c) || c == '_';
    }

    private static boolean isEscapable(char c) {
        return c == '\\' || c == '*' || c == '_' || c == '`' || c == '[' || c == ']' || c == '~';
    }

    private static boolean hasWhitespace(String text) {
        for (int i = 0; i < text.length(); i++) {
            if (Character.isWhitespace(text.charAt(i))) return true;
        }
        return false;
    }

    /** Accumulates inline runs, merging neighbours that share a style and link target. */
    private static final class Sink {

        private final java.util.List<Inline> out;
        private final StringBuilder pending;
        private int style;
        private String url;

        Sink(java.util.List<Inline> out) {
            this.out = out;
            this.pending = new StringBuilder();
            this.style = Inline.STYLE_NORMAL;
        }

        void emit(String text, int segmentStyle, String segmentUrl) {
            if (text == null || text.isEmpty()) return;
            if (pending.length() > 0 && (segmentStyle != style || !sameUrl(segmentUrl, url))) {
                flush();
            }
            style = segmentStyle;
            url = segmentUrl;
            pending.append(text);
        }

        void flush() {
            if (pending.length() == 0) return;
            out.add(new Inline(pending.toString(), style, url));
            pending.setLength(0);
        }

        private static boolean sameUrl(String a, String b) {
            return a == null ? b == null : a.equals(b);
        }
    }

    /**
     * Recursive inline scanner. It only enters markup that has a matching closer, so unmatched
     * markers fall through to literal text and every input character is either kept or consumed as
     * a matched delimiter.
     */
    private static final class InlineParser {

        private final String source;
        private final int length;
        private final Sink sink;

        /** Cached scan for the next unescaped ']' (-2 = unknown, -1 = none in the window). */
        private int bracketPos = -2;
        private int bracketFrom;
        private int bracketEnd;

        /** Per marker (* _ ~): a position from which no single / paired marker exists to the end. */
        private final int[] noSingleFrom = {-1, -1, -1};
        private final int[] noPairFrom = {-1, -1, -1};

        InlineParser(String source, Sink sink) {
            this.source = source;
            this.length = source.length();
            this.sink = sink;
        }

        void parse(int start, int end, int style, String linkUrl, int depth) {
            StringBuilder literal = new StringBuilder();
            int i = start;
            while (i < end) {
                char c = source.charAt(i);
                if (c == '\\' && i + 1 < end && isEscapable(source.charAt(i + 1))) {
                    literal.append(source.charAt(i + 1));
                    i += 2;
                    continue;
                }
                if (c == '`') {
                    int close = findBacktick(i + 1, end);
                    if (close >= 0) {
                        emitLiteral(literal, style, linkUrl);
                        String code = source.substring(i + 1, close);
                        sink.emit(code, linkUrl != null ? Inline.STYLE_LINK : Inline.STYLE_CODE,
                                linkUrl);
                        i = close + 1;
                        continue;
                    }
                    literal.append(c);
                    i++;
                    continue;
                }
                if (c == '~') {
                    if (i + 1 < end && source.charAt(i + 1) == '~') {
                        int close = depth < MAX_INLINE_DEPTH ? findPair(i + 2, end, 2, '~') : -1;
                        if (close > i + 2) {
                            emitLiteral(literal, style, linkUrl);
                            parse(i + 2, close, Inline.STYLE_STRIKE, linkUrl, depth + 1);
                            i = close + 2;
                            continue;
                        }
                        int run = runLength(i, end);
                        literal.append(source, i, i + run);
                        i += run;
                        continue;
                    }
                    literal.append(c);
                    i++;
                    continue;
                }
                if (c == '*' || c == '_') {
                    int marker = c == '*' ? 0 : 1;
                    // Underscores inside a word are literal in CommonMark (PHONE_FRPS_OK must keep
                    // its underscores); '*' has no such rule.
                    if (c == '_' && i > 0 && isWordChar(source.charAt(i - 1))) {
                        literal.append(c);
                        i++;
                        continue;
                    }
                    if (i + 1 < end && source.charAt(i + 1) == c) {
                        int close = depth < MAX_INLINE_DEPTH ? findPair(i + 2, end, marker, c) : -1;
                        boolean closable = close > i + 2
                                && !(c == '_' && close + 2 < end && isWordChar(source.charAt(close + 2)));
                        if (closable) {
                            emitLiteral(literal, style, linkUrl);
                            parse(i + 2, close, Inline.STYLE_BOLD, linkUrl, depth + 1);
                            i = close + 2;
                            continue;
                        }
                        int run = runLength(i, end);
                        literal.append(source, i, i + run);
                        i += run;
                        continue;
                    }
                    int close = depth < MAX_INLINE_DEPTH ? findSingle(i + 1, end, marker, c) : -1;
                    boolean closable = close > i + 1
                            && !(c == '_' && close + 1 < end && isWordChar(source.charAt(close + 1)));
                    if (closable) {
                        emitLiteral(literal, style, linkUrl);
                        parse(i + 1, close, Inline.STYLE_ITALIC, linkUrl, depth + 1);
                        i = close + 1;
                        continue;
                    }
                    literal.append(c);
                    i++;
                    continue;
                }
                if (c == '[' && depth < MAX_INLINE_DEPTH) {
                    int textEnd = findBracketClose(i + 1, end);
                    if (textEnd >= i + 1 && textEnd + 1 < end
                            && source.charAt(textEnd + 1) == '(') {
                        int urlEnd = indexOf(')', textEnd + 2, end);
                        if (urlEnd >= textEnd + 2) {
                            String url = source.substring(textEnd + 2, urlEnd);
                            if (!hasWhitespace(url)) {
                                emitLiteral(literal, style, linkUrl);
                                parse(i + 1, textEnd, Inline.STYLE_LINK, url, depth + 1);
                                i = urlEnd + 1;
                                continue;
                            }
                        }
                    }
                    literal.append(c);
                    i++;
                    continue;
                }
                literal.append(c);
                i++;
            }
            emitLiteral(literal, style, linkUrl);
        }

        private void emitLiteral(StringBuilder literal, int style, String linkUrl) {
            if (literal.length() == 0) return;
            if (linkUrl != null) {
                sink.emit(literal.toString(), Inline.STYLE_LINK, linkUrl);
            } else {
                sink.emit(literal.toString(), style, null);
            }
            literal.setLength(0);
        }

        private int runLength(int from, int end) {
            char c = source.charAt(from);
            int i = from + 1;
            while (i < end && source.charAt(i) == c) i++;
            return i - from;
        }

        private int findBacktick(int from, int end) {
            int i = from;
            while (i < end) {
                char c = source.charAt(i);
                if (c == '\\' && i + 1 < end) {
                    i += 2;
                    continue;
                }
                if (c == '`') return i;
                i++;
            }
            return -1;
        }

        /** First unescaped marker pair at or after {@code from}, skipping escapes and code spans. */
        private int findPair(int from, int end, int marker, char mk) {
            if (end == length && noPairFrom[marker] >= 0 && from >= noPairFrom[marker]) return -1;
            int i = from;
            int result = -1;
            while (i + 1 < end) {
                char c = source.charAt(i);
                if (c == '\\') {
                    i += 2;
                    continue;
                }
                if (c == '`') {
                    int close = findBacktick(i + 1, end);
                    i = close >= 0 ? close + 1 : i + 1;
                    continue;
                }
                if (c == mk && source.charAt(i + 1) == mk) {
                    result = i;
                    break;
                }
                i++;
            }
            if (result < 0 && end == length) noPairFrom[marker] = from;
            return result;
        }

        /** First standalone (not doubled) marker at or after {@code from}. */
        private int findSingle(int from, int end, int marker, char mk) {
            if (end == length && noSingleFrom[marker] >= 0 && from >= noSingleFrom[marker]) {
                return -1;
            }
            int i = from;
            int result = -1;
            while (i < end) {
                char c = source.charAt(i);
                if (c == '\\') {
                    i += 2;
                    continue;
                }
                if (c == '`') {
                    int close = findBacktick(i + 1, end);
                    i = close >= 0 ? close + 1 : i + 1;
                    continue;
                }
                if (c == mk) {
                    int run = runLength(i, end);
                    if (run >= 2) {
                        i += run;
                        continue;
                    }
                    result = i;
                    break;
                }
                i++;
            }
            if (result < 0 && end == length) noSingleFrom[marker] = from;
            return result;
        }

        /** First unescaped ']' in [from, end), memoised because '[' runs are common in bad input. */
        private int findBracketClose(int from, int end) {
            if (bracketPos != -2) {
                if (bracketPos >= 0) {
                    if (bracketPos >= from && bracketPos < end) return bracketPos;
                } else if (from >= bracketFrom && end <= bracketEnd) {
                    return -1;
                }
            }
            int i = from;
            int found = -1;
            while (i < end) {
                char c = source.charAt(i);
                if (c == '\\' && i + 1 < end) {
                    i += 2;
                    continue;
                }
                if (c == ']') {
                    found = i;
                    break;
                }
                i++;
            }
            bracketFrom = from;
            bracketEnd = end;
            bracketPos = found;
            return found;
        }

        private int indexOf(char target, int from, int end) {
            for (int i = from; i < end; i++) {
                if (source.charAt(i) == target) return i;
            }
            return -1;
        }
    }

    private static final class Fence {
        final char marker;
        final int length;
        final String info;

        Fence(char marker, int length, String info) {
            this.marker = marker;
            this.length = length;
            this.info = info;
        }
    }

    private static final class Heading {
        final int level;
        final String text;

        Heading(int level, String text) {
            this.level = level;
            this.text = text;
        }
    }

    private static final class ListItem {
        final boolean ordered;
        final int level;
        final String text;

        ListItem(boolean ordered, int level, String text) {
            this.ordered = ordered;
            this.level = level;
            this.text = text;
        }
    }
}
