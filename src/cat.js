// 색연필로 그린 고양이. 선이 살짝 떨리고(boil), 숨 쉬고, 꼬리를 흔들고, 눈을 깜빡입니다.
// mood: calm | happy | sleepy | low — 오늘의 상태에 따라 모습이 달라집니다.
const FUR = '#edb877', FUR_DARK = '#c9853f', CREAM = '#f8e7c9', LINE = '#5a4330', PINK = '#d9907f';

const EYES = {
  calm: `<g class="cat-blink"><ellipse cx="87" cy="79" rx="4.4" ry="6"/><ellipse cx="113" cy="79" rx="4.4" ry="6"/></g>`,
  happy: `<path d="M81 81 Q87 72 93 81 M107 81 Q113 72 119 81" fill="none" stroke="${LINE}" stroke-width="2.6" stroke-linecap="round"/>`,
  sleepy: `<path d="M81 79 Q87 84 93 79 M107 79 Q113 84 119 79" fill="none" stroke="${LINE}" stroke-width="2.6" stroke-linecap="round"/>`,
  low: `<g class="cat-blink"><ellipse cx="87" cy="81" rx="3.8" ry="4.2"/><ellipse cx="113" cy="81" rx="3.8" ry="4.2"/></g><path d="M80 72 L93 75 M120 72 L107 75" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/>`
};
const TAIL = {
  calm: 'M126 170 C160 176 176 150 160 126',
  happy: 'M126 170 C158 172 166 128 150 96',
  sleepy: 'M126 172 C150 184 172 180 178 168',
  low: 'M126 172 C150 184 172 180 178 168'
};

export function catSvg(mood = 'calm', label = '고양이') {
  if (!EYES[mood]) mood = 'calm';
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const boil = still ? '' : '<animate attributeName="seed" values="2;7;13" dur="0.72s" calcMode="discrete" repeatCount="indefinite"/>';
  // 같은 모양을 두 번 칠합니다 — 바탕색 위에 빗금을 얹어 색연필 결을 냅니다.
  const shape = (d, fill = FUR, hatch = 'cat-hatch') => `<path d="${d}" fill="${fill}"/><path d="${d}" fill="url(#${hatch})" stroke="${LINE}" stroke-width="2.3" stroke-linejoin="round"/>`;
  const earL = 'M73 64 L69 30 L96 52 Z', earR = 'M127 64 L131 30 L104 52 Z';
  return `<svg class="cat cat-${mood}" viewBox="0 0 200 200" role="img" aria-label="${label}">
  <defs>
    <filter id="cat-pencil" x="-8%" y="-8%" width="116%" height="116%">
      <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="2" result="wobble">${boil}</feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="wobble" scale="3.4" xChannelSelector="R" yChannelSelector="G" result="drawn"/>
      <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="5" result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.55" result="tooth"/>
      <feComposite in="drawn" in2="tooth" operator="in"/>
    </filter>
    <pattern id="cat-hatch" patternUnits="userSpaceOnUse" width="4.6" height="4.6" patternTransform="rotate(34)"><line x1="0" y1="0" x2="0" y2="4.6" stroke="${FUR_DARK}" stroke-width="1.5" opacity=".5"/></pattern>
    <pattern id="cat-hatch-cream" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(-28)"><line x1="0" y1="0" x2="0" y2="5" stroke="#e2c596" stroke-width="1.3" opacity=".6"/></pattern>
  </defs>
  <ellipse cx="104" cy="178" rx="56" ry="7" fill="#6f7560" opacity=".18"/>
  <g filter="url(#cat-pencil)">
    <g class="cat-tail"><path d="${TAIL[mood]}" fill="none" stroke="${LINE}" stroke-width="15" stroke-linecap="round"/><path d="${TAIL[mood]}" fill="none" stroke="${FUR}" stroke-width="10.5" stroke-linecap="round"/><path d="${TAIL[mood]}" fill="none" stroke="url(#cat-hatch)" stroke-width="10.5" stroke-linecap="round"/></g>
    <g class="cat-body">
      ${shape('M68 174 C58 130 76 96 100 96 C124 96 142 130 132 174 Z')}
      <path d="M72 136 q8 3 12 -1 M70 150 q9 3 13 -1 M128 136 q-8 3 -12 -1 M130 150 q-9 3 -13 -1" fill="none" stroke="${FUR_DARK}" stroke-width="3" stroke-linecap="round"/>
      ${shape('M100 112 C112 112 116 132 114 150 C112 164 88 164 86 150 C84 132 88 112 100 112 Z', CREAM, 'cat-hatch-cream').replace(/stroke="[^"]+" stroke-width="2.3"/, 'stroke="none"')}
      ${shape('M78 174 a10 7 0 1 1 20 0 Z', CREAM, 'cat-hatch-cream')}${shape('M102 174 a10 7 0 1 1 20 0 Z', CREAM, 'cat-hatch-cream')}
    </g>
    <g class="cat-head">
      <g class="cat-ear cat-ear-l">${shape(earL)}<path d="M77 58 L75 40 L89 52 Z" fill="${PINK}" opacity=".75"/></g>
      <g class="cat-ear cat-ear-r">${shape(earR)}<path d="M123 58 L125 40 L111 52 Z" fill="${PINK}" opacity=".75"/></g>
      ${shape('M100 50 C124 50 136 64 136 80 C136 98 120 108 100 108 C80 108 64 98 64 80 C64 64 76 50 100 50 Z')}
      <path d="M100 54 v9 M91 56 l1.5 8 M109 56 l-1.5 8" stroke="${FUR_DARK}" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="100" cy="93" rx="15" ry="10" fill="${CREAM}" opacity=".9"/>
      ${mood === 'happy' ? `<ellipse cx="76" cy="90" rx="6" ry="3.6" fill="${PINK}" opacity=".5"/><ellipse cx="124" cy="90" rx="6" ry="3.6" fill="${PINK}" opacity=".5"/>` : ''}
      <g fill="${LINE}">${EYES[mood]}</g>
      <path d="M96.5 88 h7 l-3.5 4 Z" fill="${PINK}" stroke="${LINE}" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M100 92 Q97 97.5 92.5 95 M100 92 Q103 97.5 107.5 95" fill="none" stroke="${LINE}" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M70 90 L52 86 M70 95 L53 98 M130 90 L148 86 M130 95 L147 98" stroke="${LINE}" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>
    </g>
  </g>
  ${mood === 'sleepy' ? `<g class="cat-zzz" fill="${LINE}" font-family="Gowun Batang, serif" font-weight="700"><text x="140" y="52" font-size="15">z</text><text x="152" y="38" font-size="11">z</text></g>` : ''}
</svg>`;
}
