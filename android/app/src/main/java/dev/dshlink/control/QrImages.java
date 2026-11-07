package dev.dshlink.control;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;

/**
 * 0.6.2：ZXing 解码入口（二维码图片 + 相机 Y 平面）。
 *
 * <p>只依赖 ZXing core 与 Android 图像类；实际二维码帧的拼装交给 {@link QrAssembler}。
 * RGB 路径 {@link #decodePixels(int[], int, int)} 是纯 ZXing 的，桌面冒烟测试可以直接调用。</p>
 */
public final class QrImages {

    /** 单张图片解码前缩放到的最大边长（像素）；屏幕截图/相册照片都会先缩到该范围。 */
    static final int MAX_DIMENSION = 2048;

    private QrImages() {
    }

    /** 读取一张图片并返回其中识别到的二维码文本（0 或 1 条）。 */
    public static List<String> decodeAll(Context context, Uri uri) throws IOException {
        Bitmap bitmap = loadBitmap(context, uri);
        try {
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();
            if (width <= 0 || height <= 0) return new ArrayList<>();
            int[] pixels = new int[width * height];
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
            List<String> texts = new ArrayList<>(2);
            String text = decodePixels(pixels, width, height);
            if (text != null && !text.isEmpty()) texts.add(text);
            return texts;
        } finally {
            bitmap.recycle();
        }
    }

    /**
     * 纯 ZXing 解码：ARGB 像素 → 二维码文本，识别不到返回 null。
     *
     * <p>多级兜底：正色/反色常规检测 → PURE_BARCODE → 90°/180°/270° 旋转后重试。
     * 旋转重试是必要的：ZXing 的定位图案探测启发式有方向性，个别完全合法的二维码在原始
     * 方向会漏检、旋转 90° 后能解出（见 test/.tmp/qr-hard-frame-01.png）。</p>
     */
    public static String decodePixels(int[] pixels, int width, int height) {
        if (pixels == null || width <= 0 || height <= 0 || pixels.length < width * height) {
            return null;
        }
        String text = decodeAny(pixels, width, height);
        if (text != null) return text;
        int w = width;
        int h = height;
        int[] rotated = pixels;
        for (int step = 0; step < 3; step++) {
            rotated = rotatePixels(rotated, w, h, 90);
            int swap = w;
            w = h;
            h = swap;
            text = decodeAny(rotated, w, h);
            if (text != null) return text;
        }
        return null;
    }

    /** 单个方向上的尝试：正色/反色常规检测，再 PURE_BARCODE 正色/反色。 */
    private static String decodeAny(int[] pixels, int width, int height) {
        MultiFormatReader reader = newReader();
        try {
            String text = decodeRgb(reader, pixels, width, height);
            if (text != null) return text;
            text = decodeRgb(reader, invertPixels(pixels), width, height);
            if (text != null) return text;
        } finally {
            reader.reset();
        }
        String pure = decodePure(pixels, width, height);
        if (pure != null) return pure;
        return decodePure(invertPixels(pixels), width, height);
    }

    /** PURE_BARCODE 模式兜底：把图片当成“整张就是二维码符号”来采样，适合生成器/截图导出图。 */
    private static String decodePure(int[] pixels, int width, int height) {
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        MultiFormatReader reader = new MultiFormatReader();
        reader.setHints(hints);
        try {
            return decodeRgb(reader, pixels, width, height);
        } finally {
            reader.reset();
        }
    }

    /**
     * 相机预览帧解码：{@code yPlane} 为 NV21 的 Y 平面（长度 ≥ width*height）。
     *
     * <p>先按显示方向摆正，再依次尝试 0°/90°/180°/270°：部分完全合法的二维码在某个
     * 方向会被 ZXing 的定位图案启发式漏检，旋转后即可解出（相机透视畸变下更容易碰到）。</p>
     *
     * @param rotation 顺时针旋转角度 0/90/180/270，使解码方向与屏幕一致
     */
    public static String decodeYPlane(byte[] yPlane, int width, int height, int rotation) {
        if (yPlane == null || width <= 0 || height <= 0 || yPlane.length < width * height) {
            return null;
        }
        int normalized = ((rotation % 360) + 360) % 360;
        byte[] plane = yPlane;
        int planeWidth = width;
        int planeHeight = height;
        if (normalized == 90 || normalized == 270) {
            plane = rotateY(yPlane, width, height, normalized);
            planeWidth = height;
            planeHeight = width;
        } else if (normalized == 180) {
            plane = rotateY(yPlane, width, height, 180);
        }
        String text = decodeYPlanePrepared(plane, planeWidth, planeHeight);
        if (text != null) return text;
        byte[] rotated = plane;
        int w = planeWidth;
        int h = planeHeight;
        for (int step = 0; step < 3; step++) {
            rotated = rotateY(rotated, w, h, 90);
            int swap = w;
            w = h;
            h = swap;
            text = decodeYPlanePrepared(rotated, w, h);
            if (text != null) return text;
        }
        return null;
    }

    /** 已摆正的 Y 平面单方向尝试：常规检测 + 反色重试。 */
    private static String decodeYPlanePrepared(byte[] plane, int width, int height) {
        MultiFormatReader reader = newReader();
        try {
            LuminanceSource source =
                    new PlanarYUVLuminanceSource(plane, width, height, 0, 0, width, height, false);
            String text = decodeSource(reader, source);
            if (text != null) return text;
            // 屏幕/反光偶尔会形成亮底暗码，再试一次反色。
            return decodeSource(reader, source.invert());
        } finally {
            reader.reset();
        }
    }

    static MultiFormatReader newReader() {
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        MultiFormatReader reader = new MultiFormatReader();
        reader.setHints(hints);
        return reader;
    }

    private static String decodeRgb(MultiFormatReader reader, int[] pixels, int width, int height) {
        LuminanceSource source = new RGBLuminanceSource(width, height, pixels);
        return decodeSource(reader, source);
    }

    private static String decodeSource(MultiFormatReader reader, LuminanceSource source) {
        BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
        try {
            Result result = reader.decodeWithState(bitmap);
            return result == null ? null : result.getText();
        } catch (NotFoundException err) {
            return null;
        } catch (RuntimeException err) {
            // ZXing 对极端噪声图片偶尔会抛数组越界之类的运行时异常，按“识别失败”处理。
            return null;
        }
    }

    /** 按 90° 步长顺时针旋转 ARGB 像素数组（返回新数组）。 */
    private static int[] rotatePixels(int[] pixels, int width, int height, int rotation) {
        int[] out = new int[width * height];
        if (rotation == 90) {
            for (int yy = 0; yy < height; yy++) {
                int rowBase = yy * width;
                for (int xx = 0; xx < width; xx++) {
                    out[xx * height + (height - 1 - yy)] = pixels[rowBase + xx];
                }
            }
        } else if (rotation == 270) {
            for (int yy = 0; yy < height; yy++) {
                int rowBase = yy * width;
                for (int xx = 0; xx < width; xx++) {
                    out[(width - 1 - xx) * height + yy] = pixels[rowBase + xx];
                }
            }
        } else if (rotation == 180) {
            int last = width * height - 1;
            for (int i = 0; i <= last; i++) {
                out[i] = pixels[last - i];
            }
        } else {
            System.arraycopy(pixels, 0, out, 0, out.length);
        }
        return out;
    }

    /** RGB 三通道取反（保留 alpha），用于深底浅色二维码。 */
    private static int[] invertPixels(int[] pixels) {
        int[] out = new int[pixels.length];
        for (int i = 0; i < out.length; i++) {
            out[i] = pixels[i] ^ 0x00FFFFFF;
        }
        return out;
    }

    /** 按 90° 步长顺时针旋转 Y 平面。 */
    private static byte[] rotateY(byte[] y, int width, int height, int rotation) {
        byte[] out = new byte[width * height];
        if (rotation == 90) {
            for (int yy = 0; yy < height; yy++) {
                int rowBase = yy * width;
                for (int xx = 0; xx < width; xx++) {
                    out[xx * height + (height - 1 - yy)] = y[rowBase + xx];
                }
            }
        } else if (rotation == 270) {
            for (int yy = 0; yy < height; yy++) {
                int rowBase = yy * width;
                for (int xx = 0; xx < width; xx++) {
                    out[(width - 1 - xx) * height + yy] = y[rowBase + xx];
                }
            }
        } else if (rotation == 180) {
            int last = width * height - 1;
            for (int i = 0; i <= last; i++) {
                out[i] = y[last - i];
            }
        } else {
            System.arraycopy(y, 0, out, 0, out.length);
        }
        return out;
    }

    /** 读取图片并按最大边 {@link #MAX_DIMENSION} 采样缩放，避免超大相册图片 OOM。 */
    private static Bitmap loadBitmap(Context context, Uri uri) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = open(context, uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("不是可识别的图片");
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, MAX_DIMENSION);
        Bitmap bitmap;
        try (InputStream in = open(context, uri)) {
            bitmap = BitmapFactory.decodeStream(in, null, options);
        }
        if (bitmap == null) throw new IOException("图片解码失败");
        int maxSide = Math.max(bitmap.getWidth(), bitmap.getHeight());
        if (maxSide > MAX_DIMENSION) {
            float scale = MAX_DIMENSION / (float) maxSide;
            int targetWidth = Math.max(1, Math.round(bitmap.getWidth() * scale));
            int targetHeight = Math.max(1, Math.round(bitmap.getHeight() * scale));
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true);
            if (scaled != bitmap) bitmap.recycle();
            bitmap = scaled;
        }
        return bitmap;
    }

    private static InputStream open(Context context, Uri uri) throws IOException {
        InputStream in = context.getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("无法读取图片：" + uri);
        return in;
    }

    private static int sampleSize(int width, int height, int maxDimension) {
        int sample = 1;
        while (Math.max(width / sample, height / sample) > maxDimension) {
            sample *= 2;
        }
        return sample;
    }
}
