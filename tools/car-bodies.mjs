// Кузова машины кроме седана (седан — в index.html и sideCarSvg в app.js):
// хэтчбек (по мотивам Golf), внедорожник (по мотивам Нивы 2121) и спорткар
// (по мотивам 911). Генерирует assets/car-bodies.js — разметку SVG без
// <svg> и <defs>: её вставляют в те же SVG, что и седан, и она берёт оттуда
// градиенты (carBody, brakeGlow, chrome, tint, ledGlow, underGlow; сбоку —
// sideGlow, sideChrome, sideTint) и классы деталей гаража (p-*, styles.css).
//
//   node tools/car-bodies.mjs
//
// Вид сзади — viewBox 0 0 160 150, как #car; сбоку — -4 0 146 62, как sideCarSvg.
import fs from "node:fs";

const plate = (x, y) => `<rect class="car-plate" x="${x}" y="${y}" width="38" height="11" rx="1.5"/><rect class="car-flag" x="${x + 31}" y="${y + 6}" width="5" height="3"/>`;
const plateText = y => `<text class="plate-text" x="76.5" y="${y}"></text>`;
function wheels(x1, x2, y = 46, r = 11.5) {
  const one = x => `<circle cx="${x}" cy="${y}" r="${r}" style="fill:#0b0e13"/><circle class="tyre" cx="${x}" cy="${y}" r="${r - 2}"/><circle cx="${x}" cy="${y}" r="${((r - 2) * 0.48).toFixed(2)}" style="fill:#2b323c"/><circle cx="${x}" cy="${y}" r="1.6" style="fill:#4a525d"/>`;
  return one(x1) + one(x2);
}

/* ---------- детали гаража по «якорям» кузова ---------- */
const signs = (cx, by) => `<g class="part p-sign-u"><path d="M${cx} ${by - 15} L${cx + 8.5} ${by} L${cx - 8.5} ${by} Z" fill="#fff" stroke="#e0241b" stroke-width="1.8" stroke-linejoin="round"/><text class="sign-text" x="${cx}" y="${by - 1.5}" font-size="7.5">У</text></g>`
  + `<g class="part p-sign-beginner"><rect x="${cx - 6.5}" y="${by - 13}" width="13" height="13" rx="1" fill="#f5c400" stroke="#111" stroke-width=".6"/><text class="sign-text" x="${cx}" y="${by - 2}" font-size="11">!</text></g>`;
const tint = glass => `<g class="part p-tint">${glass.map(d => `<path fill="url(#tint)" d="${d}"/>`).join("")}</g>`;
// Крыша: у седана верх крыши на y=47; dy — насколько выше/ниже у этого кузова.
const roof = dy => `<g class="part p-fin" transform="translate(0 ${dy})"><path fill="var(--car-dark)" d="M74.5 47.5 Q75.5 35.5 80 35 Q84.5 35.5 85.5 47.5 Z"/><path fill="var(--car-light)" opacity=".55" d="M77.5 46 Q78 38 80 37.5 L80 46 Z"/></g>`
  + `<g class="part p-taxi" transform="translate(0 ${dy})"><rect x="77" y="45" width="6" height="3" fill="#2a2f37"/><rect x="63" y="36" width="34" height="10" rx="2" fill="#f5c400"/>`
  + `<g fill="#111">${[0, 1, 2, 3, 4].map(k => `<rect x="${(63 + k * 6.8).toFixed(1)}" y="42" width="3.4" height="2"/><rect x="${(66.4 + k * 6.8).toFixed(1)}" y="44" width="3.4" height="2"/>`).join("")}</g>`
  + `<text class="sign-text" x="80" y="41.2" font-size="5">ТАКСИ</text></g>`;
const led = (y, x1, x2) => `<g class="part p-led"><rect x="${x1 - 5}" y="${y - 3}" width="${x2 - x1 + 10}" height="8" fill="url(#ledGlow)"/><rect x="${x1}" y="${y}" width="${x2 - x1}" height="2.2" rx="1.1" fill="#ff5147"/></g>`;
const chrome = (plateX, plateY, lines) => `<g class="part p-chrome">${lines.map(([x1, y1, x2, y2, w]) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="url(#chrome)" stroke-width="${w || 1.6}"/>`).join("")}<rect x="${plateX - 2}" y="${plateY - 2}" width="42" height="15" rx="2.5" fill="none" stroke="url(#chrome)" stroke-width="1.8"/></g>`;
const diffuser = (y, tips) => `<g class="part p-diffuser"><path fill="#0a0d11" d="M52 ${y + 7} L108 ${y + 7} L104 ${y} L56 ${y} Z"/><path stroke="#2c333c" stroke-width="1.2" d="M66 ${y + 0.5} V${y + 7} M75 ${y + 0.5} V${y + 7} M85 ${y + 0.5} V${y + 7} M94 ${y + 0.5} V${y + 7}"/>`
  + `${tips.map(x => `<ellipse cx="${x}" cy="${y + 3}" rx="3.6" ry="2.6" fill="#15191e" stroke="url(#chrome)" stroke-width="1.3"/>`).join("")}</g>`;
const race = (rx, ry, fx, fy) => `<g class="part p-race"><circle cx="${rx}" cy="${ry}" r="7" fill="#fff" stroke="#111" stroke-width="1"/><text class="sign-text" x="${rx}" y="${ry + 3}" font-size="8.5">7</text>`
  + `<rect x="${fx}" y="${fy}" width="20" height="8" fill="#fff"/><g fill="#111"><rect x="${fx}" y="${fy}" width="4" height="4"/><rect x="${fx + 8}" y="${fy}" width="4" height="4"/><rect x="${fx + 16}" y="${fy}" width="4" height="4"/><rect x="${fx + 4}" y="${fy + 4}" width="4" height="4"/><rect x="${fx + 12}" y="${fy + 4}" width="4" height="4"/></g></g>`;
const stripes = spans => `<g class="part p-stripes">${spans.map(([y, h]) => `<rect x="69" y="${y}" width="7" height="${h}"/><rect x="84" y="${y}" width="7" height="${h}"/>`).join("")}</g>`;
const fire = (xs, y) => `<g class="part p-fire">${xs.map(x => `<path class="exhaust" d="M${x} ${y} Q${x - 5} ${y + 6} ${x} ${y + 15} Q${x + 5} ${y + 6} ${x} ${y} Z"/>`).join("")}</g>`;
const glow = (cy, rx) => `<ellipse class="part p-glow" cx="80" cy="${cy}" rx="${rx}" ry="12" fill="url(#underGlow)"/>`;

/** Кузов сзади: base(mid) — рисунок, где mid (тонировка, знаки, крыша)
 * встаёт сразу после блика стекла; under — под тенью; top — поверх всего. */
const rear = (under, base, top) => under + base + top;

/* ---------- хэтчбек ---------- */
// LED-полоса — между фонарями на их высоте, посередине её прерывает эмблема.
const ledHatch = `<g class="part p-led"><rect x="60" y="88" width="40" height="8" fill="url(#ledGlow)"/>`
  + `<rect x="63" y="90.9" width="10.6" height="2.2" rx="1.1" fill="#ff5147"/><rect x="86.4" y="90.9" width="10.6" height="2.2" rx="1.1" fill="#ff5147"/></g>`;
// Сзади: нет «ступеньки» багажника — кабина плавно расширяется в плечи,
// стекло уже кузова (толстые стойки), фонари — клинья с плеч на дверь,
// между ними круглая ручка-эмблема (без марки), номер на двери.
const hatchRear = rear(glow(141, 84), `<ellipse class="car-shadow" cx="80" cy="145" rx="74" ry="6"/>
<rect class="tyre" x="15" y="116" width="22" height="28" rx="5"/><rect class="tyre" x="123" y="116" width="22" height="28" rx="5"/>
<path class="body" fill="url(#carBody)" d="M44 48 Q46 41 56 41 L104 41 Q114 41 116 48 L126 82 Q140 84 146 92 Q150 98 150 108 L150 126 Q150 134 142 134 L18 134 Q10 134 10 126 L10 108 Q10 98 14 92 Q20 84 34 82 Z"/>
<path class="light" d="M50 45 Q52 42 58 42 L102 42 Q108 42 110 45 Z"/>
<path style="fill:var(--car-dark)" d="M44 47 L116 47 L115 51 L45 51 Z"/>
<path class="glass" d="M46 80 L51 56 Q52 53 56 53 L104 53 Q108 53 109 56 L114 80 Z"/>
<path class="glint" d="M60 53 L72 53 L62 80 L50 80 Z"/>
${tint(["M46 80 L51 56 Q52 53 56 53 L104 53 Q108 53 109 56 L114 80 Z"])}${signs(101, 79)}${roof(-6)}
<path class="mirror" d="M31 80 L18 78 Q13.5 78 14 82.5 L15.5 86 L32 86 Z"/><path class="mirror" d="M129 80 L142 78 Q146.5 78 146 82.5 L144.5 86 L128 86 Z"/>
<path d="M34 84 Q80 82 126 84" stroke="var(--car-light)" stroke-width="1.2" fill="none" opacity=".7"/>
<ellipse class="brake-glow" cx="34" cy="95" rx="28" ry="10" fill="url(#brakeGlow)"/><ellipse class="brake-glow" cx="126" cy="95" rx="28" ry="10" fill="url(#brakeGlow)"/>
<path class="tail" d="M13 91 Q15 88 22 88 L66 89 L64 95 L13 99 Z"/><path class="tail" d="M147 91 Q145 88 138 88 L94 89 L96 95 L147 99 Z"/>
<circle cx="80" cy="93" r="5.6" style="fill:var(--car-dark)"/><circle cx="80" cy="93" r="5.6" fill="none" stroke="#dfe5ec" stroke-width="1.2"/>
<path d="M28 101 L132 101" stroke="var(--car-dark)" stroke-width="1"/>
${plate(61, 104)}${plateText(112.4)}
<rect class="bumper" x="11" y="121" width="138" height="14" rx="4"/>
<path d="M48 129 L112 129 L110 134 L50 134 Z" fill="#0a0d11"/>`,
  stripes([[41, 6], [80, 7], [99, 5], [115, 6]])
  + `<g class="part p-spoiler"><rect class="sp-leg" x="52" y="43" width="4" height="5"/><rect class="sp-leg" x="104" y="43" width="4" height="5"/><path class="sp-wing" d="M38 38 L122 38 L118 44 L42 44 Z"/></g>`
  + fire([32, 128], 135) + ledHatch + chrome(61, 104, [[28, 101, 132, 101], [40, 84, 120, 84, 1.3]])
  + diffuser(128, [27, 36, 124, 133]) + race(126, 112, 22, 108));

/* ---------- внедорожник ---------- */
// Сзади: коробка, почти вертикальные стойки, высокий клиренс, узкие
// вертикальные фонари по углам, рейлинги на крыше.
const nivaRear = rear(glow(138, 80), `<ellipse class="car-shadow" cx="80" cy="145" rx="72" ry="6"/>
<rect class="tyre" x="17" y="110" width="25" height="34" rx="6"/><rect class="tyre" x="118" y="110" width="25" height="34" rx="6"/>
<rect x="34" y="114" width="92" height="10" rx="2" fill="#0d1014"/>
<path class="light" d="M30 38 Q31 34 36 34 L124 34 Q129 34 130 38 Z"/>
<path class="body" fill="url(#carBody)" d="M24 82 L28 40 Q28.5 38 32 38 L128 38 Q131.5 38 132 40 L136 82 Z"/>
<path class="glass" d="M34 76 L36 45 Q36.3 43 39 43 L121 43 Q123.7 43 124 45 L126 76 Z"/>
<path class="glint" d="M46 43 L60 43 L50 76 L36 76 Z"/>
${tint(["M34 76 L36 45 Q36.3 43 39 43 L121 43 Q123.7 43 124 45 L126 76 Z"])}${signs(113, 75)}${roof(-13)}
<rect x="31" y="35.5" width="98" height="1.6" rx=".8" fill="#2a2f37"/>
<path class="mirror" d="M21 72 L10 70 Q6 70 6.5 74 L8 77 L23 77 Z"/><path class="mirror" d="M139 72 L150 70 Q154 70 153.5 74 L152 77 L137 77 Z"/>
<path class="body" fill="url(#carBody)" d="M18 88 Q18 82 24 82 L136 82 Q142 82 142 88 L144 116 L16 116 Z"/>
<path class="light" d="M24 82 L136 82 L134 84.5 L26 84.5 Z" opacity=".7"/>
<ellipse class="brake-glow" cx="26" cy="99" rx="14" ry="15" fill="url(#brakeGlow)"/><ellipse class="brake-glow" cx="134" cy="99" rx="14" ry="15" fill="url(#brakeGlow)"/>
<rect class="tail" x="20" y="87" width="12" height="24" rx="1.5"/><rect class="tail" x="128" y="87" width="12" height="24" rx="1.5"/>
<rect x="20" y="104" width="12" height="4" fill="#e8eef6" opacity=".8"/><rect x="128" y="104" width="12" height="4" fill="#e8eef6" opacity=".8"/>
<path d="M40 88 L120 88" stroke="var(--car-dark)" stroke-width="1.2"/>
<rect x="74" y="91" width="12" height="3" rx="1.5" fill="#2a2f37"/>
${plate(61, 98)}${plateText(106.4)}
<rect class="bumper" x="14" y="114" width="132" height="12" rx="2"/>`,
  stripes([[34, 4], [84, 13], [109, 5]])
  + `<g class="part p-spoiler"><rect class="sp-leg" x="40" y="37" width="4" height="5"/><rect class="sp-leg" x="116" y="37" width="4" height="5"/><path class="sp-wing" d="M20 29 L140 29 L136 37 L24 37 Z"/></g>`
  + fire([46, 114], 126) + led(88, 34, 126) + chrome(61, 98, [[24, 83, 136, 83, 1.3], [36, 88.4, 124, 88.4]])
  + diffuser(119, [42, 51, 109, 118]) + race(113, 104, 38, 99));

/* ---------- спорткар ---------- */
// Сзади: скруглённая кабина на очень широких «бёдрах», без ступеньки; на
// крышке мотора — вертикальные ламели и третий стоп; ниже сплошная световая
// полоса; номер в бампере, два выхлопа (диффузор из гаража их заменяет).
const sportRear = rear(glow(142, 86), `<ellipse class="car-shadow" cx="80" cy="145" rx="78" ry="6"/>
<rect class="tyre" x="12" y="118" width="27" height="26" rx="5"/><rect class="tyre" x="121" y="118" width="27" height="26" rx="5"/>
<path class="body" fill="url(#carBody)" d="M45 70 Q48 57 62 56 L98 56 Q112 57 115 70 L121 86 Q134 87 143 92 Q154 97 155 110 L155 128 Q155 136 147 136 L13 136 Q5 136 5 128 L5 110 Q6 97 17 92 Q26 87 39 86 Z"/>
<path class="light" d="M50 61 Q54 56.5 63 56.5 L97 56.5 Q106 56.5 110 61 Q96 59 80 59 Q64 59 50 61 Z"/>
<path class="glass" d="M47 84 Q49 70 53 66 Q56 62.5 64 62.5 L96 62.5 Q104 62.5 107 66 Q111 70 113 84 Q80 82 47 84 Z"/>
<path class="glint" d="M62 63 L74 63 L60 83.3 L50 83.8 Z"/>
${tint(["M47 84 Q49 70 53 66 Q56 62.5 64 62.5 L96 62.5 Q104 62.5 107 66 Q111 70 113 84 Q80 82 47 84 Z"])}${signs(103, 83)}${roof(9)}
<path class="mirror" d="M38 83 L25 81 Q20.5 81 21 85.5 L22.5 89 L40 89 Z"/><path class="mirror" d="M122 83 L135 81 Q139.5 81 139 85.5 L137.5 89 L120 89 Z"/>
<path style="fill:#0b0e13" d="M52 88 Q80 86 108 88 L106 97 Q80 95.5 54 97 Z"/>
<path d="M58 88.4 V96.6 M62 88.2 V96.4 M66 88 V96.2 M70 87.9 V96 M74 87.8 V95.9 M78 87.8 V95.9 M82 87.8 V95.9 M86 87.8 V95.9 M90 87.9 V96 M94 88 V96.2 M98 88.2 V96.4 M102 88.4 V96.6" style="stroke:var(--car-body)" stroke-width="1.1"/>
<rect x="74" y="89.2" width="12" height="1.6" rx=".8" fill="#ff3b30"/>
<ellipse class="brake-glow" cx="24" cy="103" rx="22" ry="8" fill="url(#brakeGlow)"/><ellipse class="brake-glow" cx="136" cy="103" rx="22" ry="8" fill="url(#brakeGlow)"/>
<path class="tail" d="M10 101 Q12 99.5 16 99.5 L144 99.5 Q148 99.5 150 101 L150 105 L10 105 Z"/>
<path d="M14 102.2 L146 102.2" stroke="#ff6a60" stroke-width=".9"/>
<path d="M60 108.5 L100 108.5" stroke="var(--car-light)" stroke-width="1.6" stroke-dasharray="3 2" opacity=".55"/>
${plate(61, 113)}${plateText(121.4)}
<rect class="bumper" x="7" y="126" width="146" height="10" rx="4"/>
<path d="M44 130 L116 130 L114 136 L46 136 Z" fill="#0a0d11"/>
<g class="stock-tips"><rect x="49" y="130.4" width="9" height="4.4" rx="2.2" fill="#2a2f37" stroke="#9aa6b2" stroke-width=".8"/><rect x="102" y="130.4" width="9" height="4.4" rx="2.2" fill="#2a2f37" stroke="#9aa6b2" stroke-width=".8"/></g>`,
  stripes([[56, 6.5], [105, 8], [124, 2]])
  + `<g class="part p-spoiler"><rect class="sp-leg" x="58" y="89" width="4" height="6"/><rect class="sp-leg" x="98" y="89" width="4" height="6"/><path class="sp-wing" d="M34 82 L126 82 L122 89 L38 89 Z"/></g>`
  + fire([53.5, 106.5], 135) + led(101.2, 10, 150) + chrome(61, 113, [[10, 108.5, 150, 108.5], [46, 86.2, 114, 86.2, 1.3]])
  + diffuser(129, [44, 53, 107, 116]) + race(130, 117, 22, 113));

/* ---------- сбоку (едет вправо, корма слева) ---------- */
// Полос сбоку нет: они идут по центру кузова. Знаки на заднем стекле и
// диффузор отсюда тоже не видны.
function side(base, { glass, spoiler, fireAt, chromeLines, raceAt, fin, taxi, glowCx, wheelsSvg }) {
  return `<ellipse class="part p-glow" cx="${glowCx}" cy="54" rx="68" ry="7" fill="url(#sideGlow)"/>`
    + `<g class="part p-fire"><path class="exhaust" d="M${fireAt[0]} ${fireAt[1]} Q${fireAt[0] - 6} ${fireAt[1] - 2} ${fireAt[0] - 12} ${fireAt[1] + 0.7} Q${fireAt[0] - 6} ${fireAt[1] + 3.5} ${fireAt[0]} ${fireAt[1] + 1.7} Z"/></g>`
    + base
    + `<g class="part p-tint">${glass.map(d => `<path fill="url(#sideTint)" d="${d}"/>`).join("")}</g>`
    + `<g class="part p-chrome">${chromeLines.map(([d, w]) => `<path d="${d}" fill="none" stroke="url(#sideChrome)" stroke-width="${w}"/>`).join("")}</g>`
    + `<g class="part p-spoiler">${spoiler}</g>`
    + `<g class="part p-race"><circle cx="${raceAt[0]}" cy="${raceAt[1]}" r="5.2" fill="#fff" stroke="#111" stroke-width=".7"/><text class="sign-text" x="${raceAt[0]}" y="${raceAt[1] + 2.3}" font-size="6.4">7</text></g>`
    + `<g class="part p-fin"><path fill="var(--car-dark)" d="${fin}"/></g>`
    + `<g class="part p-taxi"><rect x="${taxi[0] + 1.8}" y="${taxi[1] + 5.8}" width="3" height="2.2" fill="#3a414b"/><rect x="${taxi[0]}" y="${taxi[1]}" width="6.6" height="6.2" rx="1" fill="#f5c400"/><rect x="${taxi[0]}" y="${taxi[1] + 4.2}" width="6.6" height="1.1" fill="#111"/></g>`
    + wheelsSvg;
}

const hatchSide = side(`<ellipse class="car-shadow" cx="74" cy="54.6" rx="60" ry="2.6"/>
<path class="body" style="fill:var(--car-body)" d="M12 46 L12 31 Q12 27 14 24 L22 11.5 Q24 9.5 28 9.5 L76 9.5 Q81 9.5 85 12.5 L101 26 L130 29 Q138 30 138 36 L138 46 Z"/>
<path class="light" d="M24 11 Q26 9.5 29 9.5 L76 9.5 Q81 9.5 84.5 12 L83 13 L25 13 Z"/>
<path class="glass" d="M17 24.5 L25 13.5 L42 13.5 L42 25.5 L17 25.5 Z"/>
<path class="glass" d="M45 13.5 L64 13.5 L64 25.5 L45 25.5 Z"/>
<path class="glass" d="M67 13.5 L80 13.5 Q83.5 13.5 86 15.5 L97 25.5 L67 25.5 Z"/>
<path class="glint" d="M28 13.5 L33 13.5 L24 25.5 L19 25.5 Z"/>
<path d="M14 8.8 L26 8.8 L25 11 L14.5 11.6 Z" style="fill:var(--car-dark)"/>
<path class="light" d="M14 26 L103 26 L106 28.5 L13 28.5 Z"/>
<path class="mirror" d="M92 22.5 L98.5 21.5 Q100.5 21.3 100.4 23.3 L99.6 25.6 L93.5 25.6 Z"/>
<path class="crease" d="M14 36 L136 36"/>
<path class="tail" d="M12 29.5 L22 29 L21 34 L12 34.6 Z"/>
<path d="M131 30.6 L138 31.8 L138 34.6 L132 34.1 Z" style="fill:#e8eef6"/>
<path class="bumper" d="M12 39 L18 39 L18 46 L15 46 Q12 46 12 43 Z"/><path class="bumper" d="M131 39 L138 39 L138 43 Q138 46 135 46 L131 46 Z"/>
<rect class="bumper" x="41" y="43.8" width="63" height="2.4" rx="1"/>`, {
  glowCx: 74, fireAt: [13, 42], wheelsSvg: wheels(30, 116),
  glass: ["M17 24.5 L25 13.5 L42 13.5 L42 25.5 L17 25.5 Z", "M45 13.5 L64 13.5 L64 25.5 L45 25.5 Z", "M67 13.5 L80 13.5 Q83.5 13.5 86 15.5 L97 25.5 L67 25.5 Z"],
  chromeLines: [["M17 25.8 L97 25.8", 1.4], ["M25 13.5 L83 13.5", 0.9]],
  spoiler: `<path class="sp-wing" d="M8 6.5 L28 6.5 L27 9.8 L10 10.3 Z"/>`,
  raceAt: [75, 36], fin: "M38 9.6 Q34.5 6.4 30.5 4.4 Q29.5 4.1 29.4 5.2 L29.1 9.6 Z", taxi: [47, 1.6],
});

const nivaSide = side(`<ellipse class="car-shadow" cx="72" cy="56" rx="62" ry="2.6"/>
<path class="body" style="fill:var(--car-body)" d="M12 44 L12 12 Q12 8.5 15.5 8.5 L88 8.5 Q92 8.5 94 11.5 L103 25 L128 27 Q134 27.5 134 33 L134 44 Z"/>
<rect x="18" y="6.5" width="64" height="1.6" fill="#2a2f37"/><rect x="22" y="7.8" width="2" height="1" fill="#2a2f37"/><rect x="76" y="7.8" width="2" height="1" fill="#2a2f37"/>
<path class="light" d="M13 10 Q13 8.5 15.5 8.5 L88 8.5 Q91 8.5 93 10.5 L92 11.5 L13 11.5 Z"/>
<path class="glass" d="M15 12.5 L44 12.5 L44 25 L15 25 Z"/>
<path class="glass" d="M47 12.5 L88 12.5 Q90.5 12.5 92 14.5 L99 25 L47 25 Z"/>
<path class="glint" d="M22 12.5 L27 12.5 L20 25 L15 25 Z"/>
<path class="light" d="M13 25.5 L100 25.5 L102 27.5 L13 27.5 Z"/>
<path class="mirror" d="M95 21 L101 20 Q103 19.8 103 21.8 L102 24.5 L96.5 24.5 Z"/>
<path d="M12 33 L134 33" stroke="var(--car-dark)" stroke-width="1.2"/>
<path d="M46 9 L46 41 Q46 43 48 43 L98 43 L101 26" fill="none" style="stroke:var(--car-dark)" stroke-width="1"/>
<rect x="50" y="29" width="7" height="1.6" rx=".8" style="fill:var(--car-dark)"/>
<path class="tail" d="M12 28 L17 28 L17 38 L12 38 Z"/>
<path d="M129 29 L134 30 L134 33 L129.5 32.5 Z" style="fill:#e8eef6"/>
<path class="bumper" d="M9 38 L16 38 L16 44 L9 44 Z"/><path class="bumper" d="M130 38 L137 38 L137 44 L130 44 Z"/>
<path d="M17 44 Q17 31 30 31 Q43 31 43 44 Z M103 44 Q103 31 116 31 Q129 31 129 44 Z" style="fill:#0b0e13"/>`, {
  glowCx: 72, fireAt: [9, 40.5], wheelsSvg: wheels(30, 116, 47, 12.5),
  glass: ["M15 12.5 L44 12.5 L44 25 L15 25 Z", "M47 12.5 L88 12.5 Q90.5 12.5 92 14.5 L99 25 L47 25 Z"],
  chromeLines: [["M15 25.3 L99 25.3", 1.4], ["M15 12.5 L90 12.5", 0.9]],
  spoiler: `<path class="sp-wing" d="M7 6.2 L22 6.2 L21 9.4 L9 9.4 Z"/>`,
  raceAt: [73, 36], fin: "M30 6.5 Q26.5 3.3 22.5 1.3 Q21.5 1 21.4 2.1 L21.1 6.5 Z", taxi: [47, 0.3],
});

const sportSide = side(`<ellipse class="car-shadow" cx="72" cy="55" rx="64" ry="2.4"/>
<path class="body" style="fill:var(--car-body)" d="M5 46 L5 37 Q5 31 10 29 Q22 24 32 18 Q46 10.5 60 10.5 Q70 10.5 78 15 L96 27.5 Q118 30 132 34 Q138 35.5 138 40 L138 46 Z"/>
<path d="M8 33 Q14 28 24 26.5 Q38 26 44 32" fill="none" style="stroke:var(--car-light)" stroke-width="1" opacity=".6"/>
<path class="light" d="M33 18.5 Q46 11 60 11 Q70 11 77.5 15.2 L76 16.3 Q69 12.8 60 12.8 Q47 12.8 35 19.5 Z"/>
<path class="glass" d="M38 26.5 Q46 17 58 15.5 L63 15.5 L63 26.5 Z"/>
<path class="glass" d="M66 15.5 L67 15.5 Q73 15.5 77 18 L89 26.5 L66 26.5 Z"/>
<path class="glint" d="M51 16.5 L55 16 L47 26.5 L43 26.5 Z"/>
<path d="M64.5 15.5 L64.5 40 Q64.5 43 67 43" fill="none" style="stroke:var(--car-dark)" stroke-width=".9"/>
<path d="M90 28 L90 42" style="stroke:var(--car-dark)" stroke-width=".9"/>
<rect x="68" y="30" width="6" height="1.4" rx=".7" style="fill:var(--car-dark)"/>
<path class="mirror" d="M85 23 L91 22 Q93 21.8 92.9 23.8 L92 26 L86.5 26 Z"/>
<path class="tail" d="M5 31.5 L11 29.8 L11 32.6 L5 34 Z"/>
<path d="M128 33.2 L136 35 L136.5 37.5 L129 37 Z" style="fill:#e8eef6"/>
<path class="bumper" d="M5 40 L12 40 L12 46 L8 46 Q5 46 5 43 Z"/><path class="bumper" d="M130 40.5 L138 40.5 L138 43 Q138 46 135 46 L130 46 Z"/>
<rect class="bumper" x="42" y="44" width="58" height="2" rx="1"/>
<path d="M14 46 Q14 32 27 32 Q40 32 40 46 Z M100 46 Q100 33 112 33 Q124 33 124 46 Z" style="fill:#0b0e13"/>`, {
  glowCx: 72, fireAt: [6, 42], wheelsSvg: wheels(27, 112, 46, 11.5),
  glass: ["M38 26.5 Q46 17 58 15.5 L63 15.5 L63 26.5 Z", "M66 15.5 L67 15.5 Q73 15.5 77 18 L89 26.5 L66 26.5 Z"],
  chromeLines: [["M38 26.8 L89 26.8", 1.4], ["M44 17.5 Q52 15.2 63 15.2 L72 15.4", 0.9]],
  spoiler: `<path class="sp-wing" d="M3 26.5 L17 24.5 L17 27.8 L4 30 Z"/>`,
  raceAt: [77, 35.5], fin: "M49.5 11.6 Q46.5 8.4 42.5 6.6 Q41.5 6.3 41.4 7.4 L41.1 13.6 Z", taxi: [55, 4.2],
});

const oneLine = s => s.replace(/\n/g, "");
const out = `// Сгенерировано tools/car-bodies.mjs — не править руками.
// Кузова кроме седана: разметка внутри SVG машины (сзади — #car в index.html,
// сбоку — sideCarSvg в app.js), группы .b-<кузов>, видна та, что выбрана в
// гараже (car-body-<кузов>, styles.css).
export const BODIES_REAR = ${JSON.stringify(oneLine(
  `<g class="b b-hatch">${hatchRear}</g><g class="b b-niva">${nivaRear}</g><g class="b b-sport">${sportRear}</g>`))};
export const BODIES_SIDE = ${JSON.stringify(oneLine(
  `<g class="b b-hatch">${hatchSide}</g><g class="b b-niva">${nivaSide}</g><g class="b b-sport">${sportSide}</g>`))};
`;
fs.writeFileSync(new URL("../assets/car-bodies.js", import.meta.url), out);
console.log("assets/car-bodies.js:", out.length, "байт");
