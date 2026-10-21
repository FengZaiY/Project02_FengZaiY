import { presentationHash } from '../../src/core/presentation.mjs';

export function presentationFixture(data, overrides = {}) {
  return {
    v: 1, assetIds: [], noteIds: [], basis: { contentHash: presentationHash(data), sources: [] }, data: { rate: 3 },
    html: '<header><p class="eyebrow">方法与实验</p><h1>让知识可以探索</h1><p>调整输入，观察线性关系如何变化。</p></header><nav><button id="theory">原理</button><button id="experiment">参数实验</button></nav><section id="intro"><h2>从描述到理解</h2><p>线性关系表示输入每增加一个单位，输出增加相同的量。</p><blockquote>y = k × x</blockquote></section><section id="lab"><div class="controls"><label for="rate">系数 k</label><input id="rate" type="range" min="1" max="9" value="3"><output id="result">3</output><button id="step">逐步演示</button></div><div id="chart" style="height:280px;width:100%"></div><p id="steps">尚未开始</p></section><footer><h2>阅读与出处</h2><p>正文保留概念、适用条件和来源；这里用交互观察参数关系。</p><p id="bottom">实验结束后回到正文，记录你的结论。</p></footer>',
    css: 'body{max-width:980px;margin:auto;color:#29372f}header{border-bottom:2px solid #277d65;padding-bottom:18px}.eyebrow{color:#277d65;font-size:13px}nav{display:flex;gap:12px;margin:20px 0}button{border:1px solid #ccd7d0;border-radius:5px;padding:6px 14px;background:#f7faf8;color:#234438}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}output{font-size:24px;color:#ba4c3b;font-weight:600}blockquote{padding:16px;border-left:3px solid #ce6852;background:#f8f3f2}footer{border-top:1px solid #dce4df;margin-top:24px;padding-top:12px}h1{font-size:30px}h2{font-size:22px}@media(max-width:600px){h1{font-size:26px}}',
    script: `let count = 0;
function draw(k) { page.text('result', String(k)); page.chart('chart', {color:['#277d65'],tooltip:{trigger:'axis'},grid:{left:40,right:24,bottom:40,top:30},xAxis:{type:'category',data:[0,1,2,3,4]},yAxis:{type:'value',max:40},series:[{type:'line',data:[0,k,k*2,k*3,k*4],areaStyle:{opacity:0.08}}]}); }
draw(page.data.rate);
page.on('rate','input', event => { page.data.rate = Number(event.value); draw(page.data.rate); });
page.on('theory','click', () => page.show('intro',true));
page.on('experiment','click', () => page.show('intro',false));
page.on('step','click', () => { count = 0; page.every('demo',100,()=>{page.text('steps','第 '+(++count)+' 步'); if(count>=5)page.cancel('demo');}); });`,
    ...overrides
  };
}
