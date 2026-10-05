package ru.burninghouse.pdd;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;

import org.json.JSONObject;

import java.util.Map;

/**
 * Машина из гаража для виджета — та же, что на сайте: фигуры из SVG машины в
 * index.html (viewBox 160×150), цвета — из assets/styles.css (тёмная тема),
 * детали — по car из /api/widget (motivation.js carConfig). Рисуем в Bitmap:
 * RemoteViews не умеет ни SVG, ни текст поверх картинки (свой номер).
 */
final class CarPainter {
    private static final float VW = 160f, VH = 150f;
    private static final java.util.regex.Pattern TOKEN = java.util.regex.Pattern.compile("[MLQZ]|-?\\d*\\.?\\d+");

    /** {кузов, тень кузова, светлые детали} — как .car.car-paint-* в styles.css. */
    private static final Map<String, int[]> PAINT = Map.of(
            "blue", new int[]{0xFF2A62BF, 0xFF173F80, 0xFF4A80D6},
            "white", new int[]{0xFFE9EDF2, 0xFFAEB8C4, 0xFFFFFFFF},
            "black", new int[]{0xFF1C2026, 0xFF0B0D10, 0xFF3A414B},
            "green", new int[]{0xFF0F8A5F, 0xFF08573C, 0xFF35B986},
            "red", new int[]{0xFFD42A20, 0xFF8E1810, 0xFFEF5A4F},
            "silver", new int[]{0xFFAAB4BF, 0xFF6F7B88, 0xFFD8DEE5},
            "gold", new int[]{0xFFD9A900, 0xFF8A6A00, 0xFFF2CF4A});
    private static final Map<String, Integer> STRIPE = Map.of(
            "white", 0xEBF4F6F8, "black", 0xEB111418, "red", 0xEBE0241B, "gold", 0xEBF2CF4A);
    private static final Map<String, Integer> GLOW = Map.of(
            "blue", 0xFF3AA0FF, "red", 0xFFFF3B30, "purple", 0xFFB43CFF);

    private CarPainter() {}

    /** Машина шириной widthPx (высота — по пропорциям viewBox). car — null: по умолчанию. */
    static Bitmap draw(JSONObject car, int widthPx) {
        int h = Math.round(widthPx * VH / VW);
        Bitmap bmp = Bitmap.createBitmap(widthPx, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        c.scale(widthPx / VW, h / VH);
        String paintId = car == null ? "blue" : car.optString("paint", "blue");
        int[] col = PAINT.containsKey(paintId) ? PAINT.get(paintId) : PAINT.get("blue");
        int body = col[0], dark = col[1], light = col[2];

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        Integer glow = car == null ? null : GLOW.get(car.optString("glow"));
        if (glow != null) {
            // Подсветка днища — мягкое пятно цвета, как радиальный градиент на сайте.
            p.setShader(new android.graphics.RadialGradient(80, 141, 84,
                    new int[]{(glow & 0x00FFFFFF) | 0xD9000000, glow & 0x00FFFFFF}, null, android.graphics.Shader.TileMode.CLAMP));
            c.save();
            c.scale(1f, 12f / 84f, 80, 141);
            c.drawCircle(80, 141, 84, p);
            c.restore();
            p.setShader(null);
        }
        fill(c, p, glow != null ? 0x1F000000 : 0x59000000, oval(80, 145, 74, 6));            // тень
        fill(c, p, 0xFF12161C, rect(15, 116, 22, 28, 5), rect(123, 116, 22, 28, 5));     // колёса
        fill(c, p, light, path("M50 52 Q52 47 59 47 L101 47 Q108 47 110 52 Z"));
        fill(c, p, body, path("M36 81 L46 56 Q48 52 54 52 L106 52 Q112 52 114 56 L124 81 Z"));
        fill(c, p, 0xFF0B1118, path("M44 79 L52 59 Q53.4 57 56 57 L104 57 Q106.6 57 108 59 L116 79 Z"));
        fill(c, p, 0x1AFFFFFF, path("M60 57 L74 57 L62 79 L48 79 Z"));
        fill(c, p, dark, path("M31 77 L19 75 Q14.5 75 15 79.5 L16.5 83 L33 83 Z"), path("M129 77 L141 75 Q145.5 75 145 79.5 L143.5 83 L127 83 Z"));
        fill(c, p, light, path("M28 87 L132 87 L125 80 L35 80 Z"));
        fill(c, p, body, path("M12 100 Q12 88 26 87 L134 87 Q148 88 148 100 L150 126 Q150 134 142 134 L18 134 Q10 134 10 126 Z"));
        fill(c, p, 0xFF8E1C16, path("M15 92 L45 92 L43 101 L13 103 Z"), path("M145 92 L115 92 L117 101 L147 103 Z"));
        fill(c, p, (light & 0x00FFFFFF) | 0x80000000, rect(14, 107.4f, 132, 1.2f, 0));     // линия по борту
        fill(c, p, 0xFF171B22, rect(12, 124, 136, 11, 4));                                 // бампер

        Integer stripe = car == null ? null : STRIPE.get(car.optString("stripes"));
        if (stripe != null) {
            fill(c, p, stripe, rect(69, 52, 7, 5, 0), rect(84, 52, 7, 5, 0), rect(69, 87, 7, 19, 0),
                    rect(84, 87, 7, 19, 0), rect(69, 117, 7, 7, 0), rect(84, 117, 7, 7, 0));
        }
        // Номер — поверх полос, как на сайте.
        fill(c, p, 0xFFF5F5F2, rect(61, 106, 38, 11, 1.5f));
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1f);
        p.setColor(0xFF111111);
        c.drawPath(rect(61, 106, 38, 11, 1.5f), p);
        p.setStyle(Paint.Style.FILL);
        fill(c, p, 0xFF1C57C6, rect(92, 112, 5, 3, 0));
        String plate = car == null ? "" : car.optString("plate", "");
        if (!plate.isEmpty()) {
            p.setColor(0xFF111111);
            p.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
            p.setTextAlign(Paint.Align.CENTER);
            p.setTextSize(6f);
            // Длинный номер ужимаем в поле номера без флага — как setPlateText в app.js.
            float w = p.measureText(plate);
            if (w > 28f) p.setTextScaleX(28f / w);
            c.drawText(plate, 76.5f, 114.4f, p);
            p.setTextScaleX(1f);
        }

        if (car != null && "on".equals(car.optString("spoiler"))) {
            fill(c, p, 0xFF171B22, rect(40, 83, 5, 6, 0), rect(115, 83, 5, 6, 0));
            fill(c, p, dark, path("M18 77 L142 77 L138 84 L22 84 Z"));
        }
        if (car != null && "fire".equals(car.optString("exhaust"))) {
            fill(c, p, 0xB3FFCC00, path("M32 135 Q27 141 32 150 Q37 141 32 135 Z"), path("M128 135 Q123 141 128 150 Q133 141 128 135 Z"));
        }
        return bmp;
    }

    private static void fill(Canvas c, Paint p, int color, Path... shapes) {
        p.setColor(color);
        for (Path s : shapes) c.drawPath(s, p);
    }

    private static Path rect(float x, float y, float w, float h, float r) {
        Path s = new Path();
        s.addRoundRect(new RectF(x, y, x + w, y + h), r, r, Path.Direction.CW);
        return s;
    }

    private static Path oval(float cx, float cy, float rx, float ry) {
        Path s = new Path();
        s.addOval(new RectF(cx - rx, cy - ry, cx + rx, cy + ry), Path.Direction.CW);
        return s;
    }

    /** Путь SVG из команд M, L, Q, Z с абсолютными координатами — других у машины нет. */
    static Path path(String d) {
        Path s = new Path();
        // «M50 52 Q52 47 …»: буква команды слитно с числом — разбираем по токенам.
        java.util.List<String> list = new java.util.ArrayList<>();
        java.util.regex.Matcher m = TOKEN.matcher(d);
        while (m.find()) list.add(m.group());
        String[] t = list.toArray(new String[0]);
        int i = 0;
        while (i < t.length) {
            switch (t[i]) {
                case "M": s.moveTo(f(t[i + 1]), f(t[i + 2])); i += 3; break;
                case "L": s.lineTo(f(t[i + 1]), f(t[i + 2])); i += 3; break;
                case "Q": s.quadTo(f(t[i + 1]), f(t[i + 2]), f(t[i + 3]), f(t[i + 4])); i += 5; break;
                case "Z": s.close(); i += 1; break;
                default: throw new IllegalArgumentException("Команда пути не поддерживается: " + t[i]);
            }
        }
        return s;
    }

    private static float f(String s) {
        return Float.parseFloat(s);
    }
}
