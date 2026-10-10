// Synthetic amounts and model IDs, not a bundled price catalog.
export const pricePage = (input = 3, output = 9) => `<html><body><article><table>
<tr><td colspan="3">MODEL</td><td>deepseek-test<sup>(1)</sup></td><td>deepseek-other</td></tr>
<tr><td rowspan="6">PRICING<sup>(2)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.1</td><td>$0.2</td></tr>
<tr><td>PEAK</td><td>$0.2</td><td>$0.4</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$${input / 2}</td><td>$1</td></tr>
<tr><td>PEAK</td><td>$${input}</td><td>$2</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$${output / 2}</td><td>$2</td></tr>
<tr><td>PEAK</td><td>$${output}</td><td>$4</td></tr>
</table></article></body></html>`;
export const priceResponse = (input, output) => new Response(pricePage(input, output), {
  headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
