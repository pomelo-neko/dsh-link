package dev.dshlink.control;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 0.6.2：相机扫描 dshlink 动态二维码（多帧拼接）。
 *
 * <p>预览帧的 Y 平面交给 {@link QrImages#decodeYPlane}（ZXing）识别，识别出的帧文本交给
 * {@link QrAssembler} 拼装；拼齐一次连接串后把完整文本放在 {@link #EXTRA_CODE} 返回给
 * {@link MainActivity}，随后复用既有的导入/连接流程。</p>
 *
 * <p>没有相机权限或没有相机时给出明确提示并引导用“从文件导入”多选二维码截图，不崩溃。</p>
 */
public final class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    /** 拼好的完整连接串（dshlink1:/dshlink2: 文本），放在返回 Intent 里。 */
    public static final String EXTRA_CODE = "dev.dshlink.control.extra.QR_CODE";

    private static final String TAG = "dshlink-scan";
    private static final int REQUEST_CAMERA = 7011;
    /** 预览帧解码间隔：太密会占满 CPU，太疏会漏掉动态二维码的帧。 */
    private static final long DECODE_INTERVAL_MS = 150L;

    private final QrAssembler assembler = new QrAssembler();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean(false);

    private TextView statusView;
    private SurfaceView surfaceView;
    private Camera camera;
    private boolean permissionGranted;
    private boolean surfaceReady;
    private boolean destroyed;
    private boolean warnedNotFrame;
    private int previewWidth;
    private int previewHeight;
    private int dataRotation;
    private long lastAttemptAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildUi();
        permissionGranted = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        if (permissionGranted) {
            maybeStartCamera();
        } else {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (permissionGranted) maybeStartCamera();
    }

    @Override
    protected void onPause() {
        releaseCamera();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        releaseCamera();
        io.shutdownNow();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            permissionGranted = true;
            maybeStartCamera();
        } else {
            showCameraBlocked("没有相机权限，无法扫描二维码。");
        }
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER_HORIZONTAL);
        overlay.setPadding(dp(20), dp(16), dp(20), dp(24));
        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        root.addView(overlay, overlayParams);

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(16f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setBackgroundColor(0x99000000);
        statusView.setPadding(dp(12), dp(10), dp(12), dp(10));
        statusView.setText("对准屏幕上的 dshlink 动态二维码…");
        overlay.addView(statusView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setTextColor(0xCCFFFFFF);
        hint.setTextSize(13f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(8), 0, 0);
        hint.setText("连接串约 7 KB，会切成多帧循环显示；扫齐后自动导入。也可以返回主界面用“从文件导入”多选二维码截图。");
        overlay.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setOnClickListener(v -> cancelScan());
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(dp(160), ViewGroup.LayoutParams.WRAP_CONTENT);
        cancelParams.topMargin = dp(12);
        overlay.addView(cancel, cancelParams);

        setContentView(root);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void cancelScan() {
        setResult(RESULT_CANCELED);
        finish();
    }

    // ---------------------------------------------------------------- camera

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        maybeStartCamera();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        // 预览尺寸由 openCamera() 决定，这里无需处理。
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        releaseCamera();
    }

    private void maybeStartCamera() {
        if (destroyed || camera != null || !permissionGranted || !surfaceReady) return;
        openCamera();
    }

    private void openCamera() {
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            showCameraBlocked("这台设备没有可用相机。");
            return;
        }
        int cameraId = findBackCameraId();
        if (cameraId < 0) {
            showCameraBlocked("这台设备没有可用相机。");
            return;
        }
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(cameraId, info);
        Camera opened;
        try {
            opened = Camera.open(cameraId);
        } catch (RuntimeException err) {
            Log.w(TAG, "Camera.open failed", err);
            showCameraBlocked("相机打开失败：" + err.getMessage());
            return;
        }
        try {
            Camera.Parameters params = opened.getParameters();
            Camera.Size preview = choosePreviewSize(params.getSupportedPreviewSizes());
            if (preview != null) {
                params.setPreviewSize(preview.width, preview.height);
                previewWidth = preview.width;
                previewHeight = preview.height;
            } else {
                previewWidth = params.getPreviewSize().width;
                previewHeight = params.getPreviewSize().height;
            }
            List<String> focusModes = params.getSupportedFocusModes();
            if (focusModes != null) {
                if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                }
            }
            opened.setParameters(params);
            int degrees = displayRotationDegrees();
            int displayOrientation;
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
                displayOrientation = (info.orientation + degrees) % 360;
                displayOrientation = (360 - displayOrientation) % 360;
            } else {
                displayOrientation = (info.orientation - degrees + 360) % 360;
            }
            dataRotation = displayOrientation;
            opened.setDisplayOrientation(displayOrientation);
            opened.setPreviewDisplay(surfaceView.getHolder());
            int bufferSize = previewWidth * previewHeight * 3 / 2;
            opened.addCallbackBuffer(new byte[bufferSize]);
            opened.setPreviewCallbackWithBuffer(this);
            camera = opened;
            opened.startPreview();
            statusView.setText("对准屏幕上的 dshlink 动态二维码…");
        } catch (IOException | RuntimeException err) {
            Log.w(TAG, "camera preview init failed", err);
            releaseCamera();
            try {
                opened.release();
            } catch (RuntimeException ignored) {
                // 已释放/无效相机，忽略。
            }
            showCameraBlocked("相机预览初始化失败：" + err.getMessage());
        }
    }

    private static int findBackCameraId() {
        int count = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < count; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) return i;
        }
        return count > 0 ? 0 : -1;
    }

    private static Camera.Size choosePreviewSize(List<Camera.Size> sizes) {
        if (sizes == null || sizes.isEmpty()) return null;
        Camera.Size best = null;
        long bestScore = Long.MAX_VALUE;
        for (Camera.Size size : sizes) {
            if (size == null) continue;
            long longSide = Math.max(size.width, size.height);
            long shortSide = Math.min(size.width, size.height);
            if (shortSide < 480) continue;
            long score = Math.abs(longSide - 1280) * 2 + Math.abs(shortSide - 720);
            if (score < bestScore) {
                bestScore = score;
                best = size;
            }
        }
        if (best != null) return best;
        for (Camera.Size size : sizes) {
            if (size == null) continue;
            if (best == null || size.width * (long) size.height > best.width * (long) best.height) {
                best = size;
            }
        }
        return best;
    }

    private int displayRotationDegrees() {
        switch (getWindowManager().getDefaultDisplay().getRotation()) {
            case Surface.ROTATION_90:
                return 90;
            case Surface.ROTATION_180:
                return 180;
            case Surface.ROTATION_270:
                return 270;
            default:
                return 0;
        }
    }

    private void releaseCamera() {
        Camera cam = camera;
        camera = null;
        if (cam == null) return;
        try {
            cam.setPreviewCallbackWithBuffer(null);
        } catch (RuntimeException ignored) {
            // 已断开，忽略。
        }
        try {
            cam.stopPreview();
        } catch (RuntimeException ignored) {
            // 预览未启动，忽略。
        }
        try {
            cam.release();
        } catch (RuntimeException ignored) {
            // 已释放，忽略。
        }
    }

    private void showCameraBlocked(final String reason) {
        if (destroyed || isFinishing()) return;
        if (statusView != null) statusView.setText(reason);
        new AlertDialog.Builder(this)
                .setTitle("无法使用相机")
                .setMessage(reason + "\n\n你仍然可以返回主界面用“从文件导入”一次选中多张二维码截图"
                        + "（frame-01.png … frame-08.png）来导入连接串。")
                .setPositiveButton("去系统设置", (dialog, which) -> openAppSettings())
                .setNegativeButton("返回", (dialog, which) -> cancelScan())
                .setCancelable(false)
                .show();
    }

    private void openAppSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getPackageName(), null));
            startActivity(intent);
        } catch (RuntimeException err) {
            Log.w(TAG, "open app settings failed", err);
        }
        cancelScan();
    }

    // ---------------------------------------------------------------- decode

    @Override
    public void onPreviewFrame(byte[] data, Camera source) {
        Camera cam = camera;
        if (cam == null || data == null) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastAttemptAt < DECODE_INTERVAL_MS || data.length < previewWidth * previewHeight) {
            cam.addCallbackBuffer(data);
            return;
        }
        if (!decoding.compareAndSet(false, true)) {
            cam.addCallbackBuffer(data);
            return;
        }
        lastAttemptAt = now;
        final byte[] yPlane = new byte[previewWidth * previewHeight];
        System.arraycopy(data, 0, yPlane, 0, yPlane.length);
        final int width = previewWidth;
        final int height = previewHeight;
        final int rotation = dataRotation;
        cam.addCallbackBuffer(data);
        try {
            io.execute(() -> decodeFrame(yPlane, width, height, rotation));
        } catch (RejectedExecutionException err) {
            decoding.set(false);
        }
    }

    private void decodeFrame(byte[] yPlane, int width, int height, int rotation) {
        String text = null;
        try {
            text = QrImages.decodeYPlane(yPlane, width, height, rotation);
        } catch (RuntimeException err) {
            Log.w(TAG, "preview decode failed", err);
        } finally {
            decoding.set(false);
        }
        if (text == null) return;
        final String decoded = text;
        main.post(() -> handleDecoded(decoded));
    }

    private void handleDecoded(String text) {
        if (destroyed || isFinishing()) return;
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) return;
        if (trimmed.startsWith(ConnectProfile.PREFIX_V2) || trimmed.startsWith(ConnectProfile.PREFIX)) {
            // 整段连接串直接编码成单个二维码：不必拼帧。
            deliver(trimmed);
            return;
        }
        if (!QrAssembler.isFrame(trimmed)) {
            if (!warnedNotFrame) {
                warnedNotFrame = true;
                statusView.setText("识别到二维码，但不是 dsh-link 连接码；继续扫描…");
            }
            return;
        }
        boolean changed = assembler.feed(trimmed);
        if (assembler.isComplete()) {
            deliver(assembler.code());
            return;
        }
        if (changed) {
            String problem = assembler.lastProblem();
            if (problem.isEmpty()) {
                statusView.setText(assembler.progressText());
            } else {
                statusView.setText(assembler.progressText() + "\n" + problem);
            }
        }
    }

    private void deliver(String code) {
        if (code == null || code.isEmpty()) return;
        if (statusView != null) statusView.setText("已识别完整连接串，正在导入…");
        Camera cam = camera;
        if (cam != null) {
            try {
                cam.setPreviewCallbackWithBuffer(null);
            } catch (RuntimeException ignored) {
                // 忽略。
            }
        }
        Intent result = new Intent();
        result.putExtra(EXTRA_CODE, code);
        setResult(RESULT_OK, result);
        finish();
    }
}
