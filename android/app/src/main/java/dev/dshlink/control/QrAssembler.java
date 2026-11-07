package dev.dshlink.control;

import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 0.6.2：把多帧二维码文本拼回完整 dshlink 连接串。
 *
 * <p>帧格式（见 docs/QR-CONNECT.md §2）：{@code dshlinkqr:<index>/<total>:<chunk>}，index 从 1
 * 开始，chunk 按 index 升序直接拼接即原连接串。一次连接串约 7 KB，默认按 900 字符切成 8 帧，
 * 因此手机需要连续扫描动态二维码，或者一次选中多张帧截图。</p>
 *
 * <p>本类刻意只依赖 JDK（不依赖 Android / ZXing），这样构建前的 javac 冒烟测试可以直接跑它。
 * 行为约定：</p>
 * <ul>
 *   <li>帧可以乱序到达；重复扫描同一帧被忽略。</li>
 *   <li>帧总数与当前批次不一致时丢弃旧帧重新开始（二维码批次从 hub 重新生成）。</li>
 *   <li>同一序号的帧内容不同（换了新连接串）时丢弃旧帧重新开始。</li>
 *   <li>最多 {@value #MAX_FRAMES} 帧；拼出的连接串最多 {@value #MAX_CODE_CHARS} 字符。</li>
 *   <li>非帧文本（普通二维码、错误内容）不改变状态，只记录 {@link #lastProblem()}。</li>
 * </ul>
 */
public final class QrAssembler {

    public static final String FRAME_PREFIX = "dshlinkqr:";
    /** 服务端/文档约定的帧上限（total 1..32）。 */
    public static final int MAX_FRAMES = 32;
    /** 与 docs/QR-CONNECT.md 对齐的连接串长度上限。 */
    public static final int MAX_CODE_CHARS = 100000;

    private static final Pattern FRAME_PATTERN =
            Pattern.compile("^dshlinkqr:(\\d{1,9})/(\\d{1,9}):(.*)$", Pattern.DOTALL);

    private final String[] chunks = new String[MAX_FRAMES + 1];
    private int total;
    private int received;
    private String lastProblem = "";
    private boolean complete;

    public QrAssembler() {
        reset();
    }

    /** 丢弃全部已收帧，回到初始状态。 */
    public void reset() {
        Arrays.fill(chunks, null);
        total = 0;
        received = 0;
        lastProblem = "";
        complete = false;
    }

    /** 文本是否是 dshlink 二维码帧（不改变状态）。 */
    public static boolean isFrame(String text) {
        if (text == null) return false;
        return FRAME_PATTERN.matcher(text.trim()).matches();
    }

    /** 构造帧文本；主要供测试和排障使用。 */
    public static String frameText(int index, int total, String chunk) {
        if (index < 1 || total < 1 || index > total) {
            throw new IllegalArgumentException("帧序号越界：" + index + "/" + total);
        }
        return FRAME_PREFIX + index + "/" + total + ":" + (chunk == null ? "" : chunk);
    }

    /**
     * 喂入一段二维码解码文本。
     *
     * @return true 表示这是一帧且状态发生了变化（新帧或批次重置后接受）；false 表示忽略
     *         （重复帧、非帧文本、已完成或非法帧），具体原因见 {@link #lastProblem()}。
     */
    public boolean feed(String text) {
        if (complete) return false;
        if (text == null || text.trim().isEmpty()) {
            lastProblem = "二维码内容为空";
            return false;
        }
        Matcher matcher = FRAME_PATTERN.matcher(text.trim());
        if (!matcher.matches()) {
            lastProblem = "不是 dshlinkqr 帧文本";
            return false;
        }
        int index = parseInt(matcher.group(1));
        int frameTotal = parseInt(matcher.group(2));
        String chunk = matcher.group(3);
        if (index < 1 || frameTotal < 1) {
            lastProblem = "帧序号无效";
            return false;
        }
        if (frameTotal > MAX_FRAMES) {
            lastProblem = "帧总数 " + frameTotal + " 超过上限 " + MAX_FRAMES;
            return false;
        }
        if (index > frameTotal) {
            lastProblem = "帧序号 " + index + " 大于总帧数 " + frameTotal;
            return false;
        }
        if (chunk.isEmpty()) {
            lastProblem = "第 " + index + " 帧内容为空";
            return false;
        }
        if (total != 0 && total != frameTotal) {
            int previous = total;
            reset();
            lastProblem = "总帧数不一致（之前 " + previous + " 帧，现在 " + frameTotal + " 帧），已重新开始";
        }
        if (total == 0) {
            total = frameTotal;
        }
        String existing = chunks[index];
        if (existing != null) {
            if (existing.equals(chunk)) {
                // 重复扫描同一帧：不算新进展，但也不是错误。
                return false;
            }
            reset();
            total = frameTotal;
            lastProblem = "第 " + index + " 帧的内容与之前不一致，已重新开始";
        }
        long length = 0;
        for (int i = 1; i <= total; i++) {
            if (chunks[i] != null) length += chunks[i].length();
        }
        if (length + chunk.length() > MAX_CODE_CHARS) {
            reset();
            lastProblem = "连接串超过 " + MAX_CODE_CHARS + " 字符上限，已重新开始";
            return false;
        }
        chunks[index] = chunk;
        received++;
        if (received >= total) {
            complete = true;
            lastProblem = "";
        }
        return true;
    }

    /** 已收齐全部帧且拼装成功。 */
    public boolean isComplete() {
        return complete;
    }

    /** 已收到的不同帧数。 */
    public int received() {
        return received;
    }

    /** 本批二维码的总帧数；尚未收到任何帧时为 0。 */
    public int total() {
        return total;
    }

    /** 拼好的完整连接串；未收齐时返回 null。 */
    public String code() {
        if (!complete) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= total; i++) {
            sb.append(chunks[i]);
        }
        return sb.toString();
    }

    /** 最近一次失败/重置的原因；没有问题时为空串。 */
    public String lastProblem() {
        return lastProblem;
    }

    /** 扫描进度文案，直接显示在扫描界面上（乱序/漏帧时提示还缺哪几帧）。 */
    public String progressText() {
        if (complete) return "已收齐 " + total + " 帧";
        if (total == 0) return "尚未扫描到 dshlink 二维码";
        String missing = missingFramesSummary(4);
        if (missing.isEmpty()) return "已扫描 " + received + "/" + total + " 帧，请继续对准";
        return "已扫描 " + received + "/" + total + " 帧，还缺第 " + missing + " 帧，请继续对准";
    }

    /** 还缺哪些帧（从 1 开始，逗号分隔，超出 limit 时用“…”收尾）；已收齐返回空串。 */
    public String missingFramesSummary(int limit) {
        if (total == 0 || complete) return "";
        StringBuilder sb = new StringBuilder();
        int shown = 0;
        int missingCount = 0;
        for (int i = 1; i <= total; i++) {
            if (chunks[i] != null) continue;
            missingCount++;
            if (shown < limit) {
                if (sb.length() > 0) sb.append("、");
                sb.append(i);
                shown++;
            }
        }
        if (missingCount > shown) sb.append("…");
        return sb.toString();
    }

    private static int parseInt(String value) {
        try {
            long parsed = Long.parseLong(value);
            if (parsed < 0 || parsed > Integer.MAX_VALUE) return -1;
            return (int) parsed;
        } catch (NumberFormatException err) {
            return -1;
        }
    }
}
