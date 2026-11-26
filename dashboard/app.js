(function(){'use strict';var PAGE_SIZE=12;var SORT_COLUMNS=[{key:'rank',label:'Rank',className:'col-rank',numeric:false}
,{key:'name',label:'Protocol',className:'col-name',numeric:false}
,{key:'category',label:'Category',className:'col-category',numeric:false}
,{key:'tvlUsd',label:'TVL',className:'col-tvl',numeric:true}
,{key:'change7d',label:'7d',className:'col-change',numeric:true}
,{key:'impliedValueUsd',label:'Implied cap',className:'col-implied',numeric:true}
,{key:'bandWidth',label:'Empirical band',className:'col-band',numeric:false}
,{key:'peerCount',label:'Peers',className:'col-peers',numeric:true}
,{key:'evidence',label:'Evidence',className:'col-evidence',numeric:false}
];var DEFAULT_DIRECTION={rank:'asc',name:'asc',category:'asc',tvlUsd:'desc',change7d:'desc',impliedValueUsd:'desc',bandWidth:'desc',peerCount:'desc',evidence:'asc'}
;var FARM_STATUS_LABELS={'source-backed':'Source-backed','verify-terms':'Verify terms','research-only':'Research only'}
;var state={query:'',category:'all',watchlistOnly:false,evidence:'all',sortKey:'rank',sortDir:'asc',page:1}
;var app=document.getElementById('app');var mastheadMeta=document.getElementById('masthead-meta');var footerSource=document.getElementById('footer-source');var announcer=document.getElementById('announcer');var data=null;var rows=[];var bandDomain=null;var ledger=null;var view='board';var lastBoardScroll=0;var lastRenderedRoute=null;function el(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function put(parent){for(var i=1;i<arguments.length;i+=1){var child=arguments[i];if(child!==null&&child!==undefined)parent.appendChild(child);}
return parent;}
function finite(value){return typeof value==='number'&&isFinite(value);}
function positive(value){return finite(value)&&value>0;}
function num(value){return finite(value)?value:null;}
function asText(value){return typeof value==='string'?value.trim():'';}
function sentenceCase(value){if(!value)return'';return value.charAt(0).toUpperCase()+value.slice(1);}
var FLAG_LABELS={'interval-wide':'Wide interval'}
;function flagLabel(flag){return FLAG_LABELS[flag]||sentenceCase(String(flag).replace(/-/g,' ')).replace(/\bTvl\b/g,'TVL');}
function usd(value){if(!positive(value))return'—';if(value>=1e12)return'$'+(value/1e12).toFixed(value>=1e13?0:1)+'T';if(value>=1e9)return'$'+(value/1e9).toFixed(value>=1e10?0:1)+'B';if(value>=1e6)return'$'+(value/1e6).toFixed(value>=1e7?0:1)+'M';if(value>=1e3)return'$'+(value/1e3).toFixed(value>=1e4?0:1)+'K';return'$'+Math.round(value);}
function usdFull(value){return positive(value)?'$'+Math.round(value).toLocaleString('en-US'):'Not supplied';}
function fmtCount(value){return finite(value)?value.toLocaleString('en-US'):'—';}
function formatDecimal(value,digits){if(!finite(value))return'—';return value.toFixed(digits);}
function formatCoverage(value){if(!finite(value))return'—';var percent=value<=1?value*100:value;return Math.round(percent)+'%';}
function percentLevel(value){if(!finite(value))return null;var percent=value<=1?value*100:value;return Math.round(percent)+'%';}
function formatChange(value){if(!finite(value))return'—';var sign=value>0?'+':'';return sign+value.toFixed(1)+'%';}
function changeClass(value){if(!finite(value)||value===0)return'change--flat';return value>0?'change--up':'change--down';}
function formatMultiple(low,high){if(!positive(low)||!positive(high)||high<=low)return null;var multiple=high/low;return(multiple>=10?multiple.toFixed(1):multiple.toFixed(2))+'×';}
function normalizeMetric(raw){raw=raw&&typeof raw==='object'?raw:{}
;return{medianAbsLogError:num(raw.medianAbsLogError),coverage:num(raw.coverage),mape:num(raw.medianAbsolutePercentageError)}
;}
function normalizeBenchmark(raw){if(!raw||typeof raw!=='object')return null;return{sampleN:num(raw.sampleN),selected:normalizeMetric(raw.selected),global:normalizeMetric(raw.global),category:normalizeMetric(raw.category),intervalLevel:num(raw.intervalLevel),label:asText(raw.label)}
;}
function has(metric){return metric&&(finite(metric.medianAbsLogError)||finite(metric.coverage)||finite(metric.mape));}
function readData(){var raw=globalThis.TOKEN_RADAR_DATA;if(!raw||typeof raw!=='object'||!Array.isArray(raw.rows)||raw.rows.length===0){return null;}
var usableRows=raw.rows.filter(function(row){return row&&typeof row==='object'&&typeof row.slug==='string'&&row.slug.trim();}
);if(usableRows.length===0)return null;return{asOf:asText(raw.asOf),source:asText(raw.source),counts:raw.counts&&typeof raw.counts==='object'?raw.counts:null,benchmark:normalizeBenchmark(raw.benchmark),rows:usableRows}
;}
function buildBandDomain(sourceRows){var values=[];sourceRows.forEach(function(row){if(positive(row.lowUsd))values.push(row.lowUsd);if(positive(row.highUsd))values.push(row.highUsd);if(positive(row.impliedValueUsd))values.push(row.impliedValueUsd);}
);if(values.length<2)return null;var min=Math.min.apply(null,values);var max=Math.max.apply(null,values);if(!positive(min)||!positive(max)||max<=min)return null;var logMin=Math.log10(min)-Math.log10(1.08);var logMax=Math.log10(max)+Math.log10(1.08);if(!isFinite(logMin)||!isFinite(logMax)||logMax<=logMin)return null;return{min:min,max:max,logMin:logMin,logMax:logMax}
;}
function computeLocalDomain(values){var usable=values.filter(positive);if(usable.length<2)return null;var min=Math.min.apply(null,usable);var max=Math.max.apply(null,usable);if(max<=min){min=min/1.15;max=max*1.15;}
var logMin=Math.log10(min);var logMax=Math.log10(max);if(!isFinite(logMin)||!isFinite(logMax)||logMax<=logMin)return null;return{logMin:logMin,logMax:logMax}
;}
function bandPosition(value,domain){if(!positive(value)||!domain)return null;var percent=((Math.log10(value)-domain.logMin)/(domain.logMax-domain.logMin))*100;return Math.max(0,Math.min(100,percent));}
function countsText(){if(!data.counts)return'';var labels=[['protocols','protocols'],['candidates','candidates'],['watchlist','watched'],['peers','peers'],['excluded','excluded']];return labels.filter(function(pair){return finite(data.counts[pair[0]]);}
).map(function(pair){return fmtCount(data.counts[pair[0]])+' '+pair[1];}
).join(' · ');}
function updateChrome(){if(!data){mastheadMeta.textContent='No snapshot loaded';return;}
var parts=[];parts.push(data.asOf?'Snapshot '+data.asOf:'Snapshot date not supplied');if(data.counts&&finite(data.counts.protocols)){parts.push(fmtCount(data.counts.protocols)+' protocols');}
mastheadMeta.textContent=parts.join(' · ');footerSource.textContent=data.source?'Source: '+data.source:'No source string was supplied with this snapshot.';}
function renderNoData(message){view='board';mastheadMeta.textContent='No snapshot loaded';footerSource.textContent='Source appears when the snapshot is available.';var section=el('section','no-data');var title=el('h1',null,'No snapshot loaded');title.id='page-title';title.tabIndex=-1;put(section,title);if(message)put(section,el('p',null,message));else put(section,el('p',null,'This local ledger reads a generated ../data.js file. That file is missing, so no valuation rows are shown.'));put(section,el('p',null,'Generate the snapshot, then reload.'));app.replaceChildren(section);announcer.textContent='No snapshot data available.';}
function buildBenchMissing(sampleN,intervalLevel,reasonText){var section=el('aside','bench bench-missing');section.setAttribute('aria-labelledby','bench-title');var head=el('div','bench__head');var title=el('h2',null,'Held-out comparison');title.id='bench-title';var sampleParts=[];if(finite(sampleN))sampleParts.push('n = '+fmtCount(sampleN));if(percentLevel(intervalLevel))sampleParts.push(percentLevel(intervalLevel)+' band');var sample=el('span','bench__sample',sampleParts.length?sampleParts.join(' · '):'No sample supplied');put(head,title,sample);put(section,head);put(section,el('p','bench__label',reasonText||'No held-out metrics supplied; per-row bands still shown where supplied.'));return section;}
function buildBenchmark(){var bench=data.benchmark;if(!bench){return buildBenchMissing(null,null,'No held-out benchmark block was supplied with this snapshot.');}
if(!(bench&&(has(bench.selected)||has(bench.category)||has(bench.global)))){return buildBenchMissing(bench.sampleN,bench.intervalLevel,'Benchmark block present, but no held-out metrics were supplied.');}
var section=el('aside','bench');section.setAttribute('aria-labelledby','bench-title');var head=el('div','bench__head');var title=el('h2',null,'Held-out comparison');title.id='bench-title';var sampleParts=[];if(finite(bench.sampleN))sampleParts.push('n = '+fmtCount(bench.sampleN));if(percentLevel(bench.intervalLevel))sampleParts.push(percentLevel(bench.intervalLevel)+' band');var sample=el('span','bench__sample',sampleParts.length?sampleParts.join(' · '):'Sample not supplied');put(head,title,sample);put(section,head);put(section,el('p','bench__label',bench.label||'Compares implied caps with realized peer caps on a held-out split.'));var groups=[{label:'Selected model',metric:bench.selected,isGlobal:false,isSelected:true}
,{label:'Category baseline',metric:bench.category,isGlobal:false,isSelected:false}
,{label:'Global, wide band',metric:bench.global,isGlobal:true,isSelected:false}
];var maxError=0;groups.forEach(function(group){if(finite(group.metric.medianAbsLogError)){maxError=Math.max(maxError,group.metric.medianAbsLogError);}
}
);var table=el('table','bench-table');var caption=el('caption','sr-only','Held-out benchmark comparison by model');put(table,caption);var thead=el('thead');var headRow=el('tr');put(headRow,el('th',null,'Model'),el('th','num','Median error'),el('th','num','Coverage'),el('th','num','MAPE'));put(thead,headRow);put(table,thead);var tbody=el('tbody');groups.forEach(function(group){var tr=el('tr',group.isGlobal?'is-global':(group.isSelected?'is-selected':null));put(tr,el('td','model',group.label),el('td','num'),el('td','num',formatCoverage(group.metric.coverage)),el('td','num',formatCoverage(group.metric.mape)));var errorCell=tr.children[1];put(errorCell,el('span','error-value',formatDecimal(group.metric.medianAbsLogError,2)));if(finite(group.metric.medianAbsLogError)&&maxError>0){var bar=el('div','bench-errorbar');var fill=el('span');fill.style.width=Math.max(2,Math.round((group.metric.medianAbsLogError/maxError)*100))+'%';put(bar,fill);put(errorCell,bar);}
put(tbody,tr);}
);put(table,tbody);put(section,table);var noteText='Median error is the median absolute log error of the implied versus realized market cap. Held-out comparison, not a launch backtest. Coverage is the share of';if(finite(bench.sampleN))noteText+=' '+fmtCount(bench.sampleN);noteText+=' held-out peers whose realized market cap fell inside the empirical band';if(percentLevel(bench.intervalLevel))noteText+=' at the '+percentLevel(bench.intervalLevel)+' target';noteText+='. The global row is the broad pooled reference.';put(section,el('p','bench-note',noteText));return section;}
function buildIntro(){var section=el('section','intro');section.setAttribute('aria-labelledby','page-title');var main=el('div','intro__main');var title=el('h1','page-title','The tokenless, priced by peers.');title.id='page-title';title.tabIndex=-1;put(main,title);var datelineParts=[];datelineParts.push(data.asOf?'Snapshot '+data.asOf:'Snapshot date not supplied');var counts=countsText();if(counts)datelineParts.push(counts);put(main,el('p','dateline',datelineParts.join(' · ')));var lede=el('p','lede');put(lede,document.createTextNode('A cross-sectional valuation ledger for token-less protocols, benchmarked against tokenized peers in one frozen DefiLlama snapshot. Implied market caps are '),el('strong',null,'benchmarks, not forecasts.'));put(main,lede);put(section,main,buildBenchmark());return section;}
function categoryOptions(){var categories=[];var seen={}
;rows.forEach(function(row){if(row.category&&!seen[row.category]){seen[row.category]=true;categories.push(row.category);}
}
);categories.sort(function(a,b){return a.localeCompare(b);}
);return categories;}
function hasUncategorized(){return rows.some(function(row){return!row.category;}
);}
function tokenStatuses(){var values=[];var seen={}
;rows.forEach(function(row){if(row.tokenStatus&&!seen[row.tokenStatus]){seen[row.tokenStatus]=true;values.push(row.tokenStatus);}
}
);values.sort(function(a,b){return a.localeCompare(b);}
);return values;}
function buildField(labelText,control,extraClass){var field=el('div','field'+(extraClass?' '+extraClass:''));var label=el('label',null,labelText);label.htmlFor=control.id;put(field,label,control);return field;}
function buildSelect(id,options,selectedValue){var wrap=el('div','select-wrap');var select=el('select');select.id=id;options.forEach(function(option){var item=el('option',null,option.label);item.value=option.value;if(option.value===selectedValue)item.selected=true;put(select,item);}
);put(wrap,select);return{wrap:wrap,select:select}
;}
function buildControls(){var section=el('section','controls');section.setAttribute('aria-label','Filter and sort the valuation ledger');var searchInput=el('input');searchInput.type='search';searchInput.id='filter-q';searchInput.placeholder='Name, slug, chain, or evidence flag';searchInput.value=state.query;searchInput.autocomplete='off';var searchField=buildField('Search protocols',searchInput,'field--search');put(section,searchField);var categorySelectData=buildSelect('filter-category',[{value:'all',label:'All categories'}
].concat(categoryOptions().map(function(category){return{value:category,label:category}
;}
)).concat(hasUncategorized()?[{value:'__none__',label:'Uncategorized'}
]:[]),state.category);var categoryField=buildField('Category',categorySelectData.wrap,'field--category');put(section,categoryField);var evidenceOptions=[{value:'all',label:'Any evidence status'}
,{value:'flagged',label:'Flagged records'}
,{value:'clear',label:'No flags'}
,{value:'farm:source-backed',label:'Farm: source-backed'}
,{value:'farm:verify-terms',label:'Farm: verify terms'}
,{value:'farm:research-only',label:'Farm: research only'}
].concat(tokenStatuses().map(function(status){return{value:'status:'+status,label:'Status: '+status}
;}
));var evidenceSelectData=buildSelect('filter-evidence',evidenceOptions,state.evidence);var evidenceField=buildField('Evidence',evidenceSelectData.wrap,'field--evidence');put(section,evidenceField);var sortSelectData=buildSelect('filter-sort',SORT_COLUMNS.map(function(column){return{value:column.key,label:column.label}
;}
),state.sortKey);var sortField=buildField('Sort by',sortSelectData.wrap,'field--sort');put(section,sortField);var checkField=el('div','field field--check');var checkbox=el('input');checkbox.type='checkbox';checkbox.id='filter-watchlist';checkbox.checked=state.watchlistOnly;var watchCount=rows.filter(function(row){return row.watchlist;}
).length;var checkLabel=el('label','check-label','Watchlist only ('+watchCount+')');checkLabel.htmlFor=checkbox.id;put(checkField,checkbox,checkLabel);put(section,checkField);var reset=el('button','button-reset','Reset filters');reset.type='button';put(section,reset);function onFilterChange(){state.page=1;updateLedger(true);syncControls();}
searchInput.addEventListener('input',function(){state.query=searchInput.value;state.page=1;updateLedger(true);}
);categorySelectData.select.addEventListener('change',function(){state.category=categorySelectData.select.value;onFilterChange();}
);evidenceSelectData.select.addEventListener('change',function(){state.evidence=evidenceSelectData.select.value;onFilterChange();}
);sortSelectData.select.addEventListener('change',function(){state.sortKey=sortSelectData.select.value;state.sortDir=DEFAULT_DIRECTION[state.sortKey]||'asc';state.page=1;updateLedger(true);syncControls();}
);checkbox.addEventListener('change',function(){state.watchlistOnly=checkbox.checked;onFilterChange();}
);reset.addEventListener('click',function(){resetAll();}
);ledger=ledger||{}
;ledger.searchInput=searchInput;ledger.categorySelect=categorySelectData.select;ledger.evidenceSelect=evidenceSelectData.select;ledger.sortSelect=sortSelectData.select;ledger.watchlistInput=checkbox;return section;}
function syncControls(){if(!ledger)return;if(ledger.searchInput)ledger.searchInput.value=state.query;if(ledger.categorySelect)ledger.categorySelect.value=state.category;if(ledger.evidenceSelect)ledger.evidenceSelect.value=state.evidence;if(ledger.sortSelect)ledger.sortSelect.value=state.sortKey;if(ledger.watchlistInput)ledger.watchlistInput.checked=state.watchlistOnly;updateSortIndicators();}
function buildLedger(){var section=el('section','ledger-section');section.setAttribute('aria-labelledby','ledger-title');var head=el('div','ledger-head');var title=el('h2',null,'Valuation ledger');title.id='ledger-title';var resultCount=el('p','result-count');resultCount.id='result-count';put(head,title,resultCount);put(section,head);var axis=el('p','axis-note');axis.id='axis-note';if(bandDomain){var level=percentLevel(data.benchmark&&data.benchmark.intervalLevel);axis.textContent='Bars share one global log scale from '+usd(bandDomain.min)+' to '+usd(bandDomain.max)+'. Each bar is a row’s empirical'+(level?' '+level:'')+' band; the vertical mark is the implied value.';}
else{axis.textContent='Empirical band bars are unavailable in this build.';}
put(section,axis);var tableWrap=el('div','table-wrap');tableWrap.id='table-wrap';var table=el('table','ledger-table');var caption=el('caption','sr-only','Protocol valuation ledger');put(table,caption);var thead=el('thead');var headerRow=el('tr');SORT_COLUMNS.forEach(function(column){var th=el('th',column.className+(column.numeric?' num':''));th.scope='col';th.dataset.key=column.key;th.setAttribute('aria-sort','none');var button=el('button','sort-btn',column.label);button.type='button';button.dataset.sortKey=column.key;button.setAttribute('aria-label','Sort by '+column.label.toLowerCase());var arrow=el('span','sort-arrow');arrow.setAttribute('aria-hidden','true');put(button,arrow);button.addEventListener('click',function(){setSort(column.key);}
);put(th,button);if(column.key==='bandWidth'&&bandDomain){var scale=el('span','col-scale');scale.setAttribute('aria-hidden','true');put(scale,el('span',null,usd(bandDomain.min)),el('span',null,'log scale'),el('span',null,usd(bandDomain.max)));put(th,scale);}
put(headerRow,th);}
);put(thead,headerRow);put(table,thead);var tbody=el('tbody');tbody.id='ledger-body';put(table,tbody);put(tableWrap,table);put(section,tableWrap);var empty=el('div','empty-state');empty.id='empty-state';empty.hidden=true;var emptyTitle=el('h3',null,'No protocols match these filters.');var emptyText=el('p',null,'The full snapshot is loaded. Clear a filter or change the search.');var emptyReset=el('button','button-reset','Reset filters');emptyReset.type='button';emptyReset.addEventListener('click',resetAll);put(empty,emptyTitle,emptyText,emptyReset);put(section,empty);var pager=el('div','pager');pager.id='pager';var pagerLabel=el('p','pager__label');pagerLabel.id='pager-label';var buttons=el('div','pager__buttons');var prev=el('button',null,'Previous');prev.type='button';prev.id='pager-prev';var next=el('button',null,'Next');next.type='button';next.id='pager-next';prev.addEventListener('click',function(){if(state.page>1){state.page-=1;updateLedger(true);}
}
);next.addEventListener('click',function(){var total=Math.max(1,Math.ceil(filteredRows().length/PAGE_SIZE));if(state.page<total){state.page+=1;updateLedger(true);}
}
);put(buttons,prev,next);put(pager,pagerLabel,buttons);put(section,pager);var controlRefs=ledger||{}
;ledger={section:section,tableWrap:tableWrap,table:table,tbody:tbody,resultCount:resultCount,axis:axis,empty:empty,emptyReset:emptyReset,pager:pager,pagerLabel:pagerLabel,prev:prev,next:next,searchInput:controlRefs.searchInput,categorySelect:controlRefs.categorySelect,evidenceSelect:controlRefs.evidenceSelect,sortSelect:controlRefs.sortSelect,watchlistInput:controlRefs.watchlistInput}
;return section;}
function renderBoard(){var fragment=document.createDocumentFragment();put(fragment,buildIntro());put(fragment,buildControls());put(fragment,buildLedger());app.replaceChildren(fragment);syncControls();updateLedger(false);updateChrome();}
function setSort(key){if(state.sortKey===key){state.sortDir=state.sortDir==='asc'?'desc':'asc';}
else{state.sortKey=key;state.sortDir=DEFAULT_DIRECTION[key]||'asc';}
state.page=1;updateLedger(true);syncControls();}
function updateSortIndicators(){if(!ledger||!ledger.table)return;var headers=ledger.table.querySelectorAll('th[data-key]');Array.prototype.forEach.call(headers,function(th){var active=th.dataset.key===state.sortKey;th.setAttribute('aria-sort',active?(state.sortDir==='asc'?'ascending':'descending'):'none');var button=th.querySelector('.sort-btn');if(!button)return;button.classList.toggle('is-active',active);var arrow=button.querySelector('.sort-arrow');if(arrow)arrow.textContent=active?(state.sortDir==='asc'?'↑':'↓'):'';}
);}
function filteredRows(){var query=state.query.trim().toLowerCase();return rows.filter(function(row){if(state.category!=='all'){if(state.category==='__none__'){if(row.category)return false;}
else if(row.category!==state.category){return false;}
}
if(state.watchlistOnly&&!row.watchlist)return false;if(state.evidence==='flagged'&&row.flags.length===0)return false;if(state.evidence==='clear'&&row.flags.length>0)return false;if(state.evidence.indexOf('status:')===0){var wantedStatus=state.evidence.slice('status:'.length);if(row.tokenStatus!==wantedStatus)return false;}
if(state.evidence.indexOf('farm:')===0){var wantedFarmStatus=state.evidence.slice('farm:'.length);if(!row.farm||row.farm.status!==wantedFarmStatus)return false;}
if(query){var haystack=[row.name,row.slug,row.category||'',row.chains.join(' '),row.tokenStatus,row.flags.map(flagLabel).join(' '),row.farm?row.farm.status:''].join(' ').toLowerCase();if(haystack.indexOf(query)===-1)return false;}
return true;}
);}
function rowBandWidth(row){if(!positive(row.lowUsd)||!positive(row.highUsd)||row.highUsd<=row.lowUsd){return null;}
return Math.log(row.highUsd/row.lowUsd);}
function compareRows(left,right,key){var leftValue;var rightValue;switch(key){case'rank':leftValue=left.rank;rightValue=right.rank;break;case'name':leftValue=left.name;rightValue=right.name;break;case'category':leftValue=left.category||'';rightValue=right.category||'';break;case'tvlUsd':leftValue=left.tvlUsd;rightValue=right.tvlUsd;break;case'change7d':leftValue=left.change7d;rightValue=right.change7d;break;case'impliedValueUsd':leftValue=left.impliedValueUsd;rightValue=right.impliedValueUsd;break;case'bandWidth':leftValue=rowBandWidth(left);rightValue=rowBandWidth(right);break;case'peerCount':leftValue=left.peerCount;rightValue=right.peerCount;break;case'evidence':leftValue=left.flags.length;rightValue=right.flags.length;break;default:leftValue=left.rank;rightValue=right.rank;}
var leftMissing=leftValue===null||leftValue===undefined||leftValue==='';var rightMissing=rightValue===null||rightValue===undefined||rightValue==='';if(leftMissing&&rightMissing){return left.name.localeCompare(right.name);}
if(leftMissing)return 1;if(rightMissing)return-1;var comparison;if(typeof leftValue==='number'&&typeof rightValue==='number'){comparison=leftValue-rightValue;}
else{comparison=String(leftValue).localeCompare(String(rightValue),'en',{sensitivity:'base'}
);}
if(comparison===0){comparison=left.name.localeCompare(right.name,'en',{sensitivity:'base'}
);}
return state.sortDir==='desc'?-comparison:comparison;}
function sortedFilteredRows(){return filteredRows().slice().sort(function(a,b){return compareRows(a,b,state.sortKey);}
);}
function sortDescription(){var column=SORT_COLUMNS.filter(function(item){return item.key===state.sortKey;}
)[0]||{label:'Rank'}
;var asc=state.sortDir==='asc';if(state.sortKey==='name'||state.sortKey==='category')return column.label.toLowerCase()+(asc?', A to Z':', Z to A');if(state.sortKey==='rank')return'rank, '+(asc?'low to high':'high to low');if(state.sortKey==='evidence')return'evidence, '+(asc?'fewest flags first':'most flags first');if(state.sortKey==='bandWidth')return'band width, '+(asc?'narrow to wide':'wide to narrow');if(state.sortKey==='peerCount')return'peers, '+(asc?'fewest first':'most first');if(state.sortKey==='impliedValueUsd')return'implied cap, '+(asc?'low to high':'high to low');return column.label+', '+(asc?'low to high':'high to low');}
function createBandCell(row){var td=el('td','col-band cell-band');var track=el('div','band-track');var rangePercent=null;var midPercent=null;if(bandDomain&&positive(row.lowUsd)&&positive(row.highUsd)){var low=bandPosition(row.lowUsd,bandDomain);var high=bandPosition(row.highUsd,bandDomain);midPercent=bandPosition(row.impliedValueUsd,bandDomain);if(low!==null&&high!==null){rangePercent={left:Math.min(low,high),width:Math.max(1,Math.abs(high-low))}
;}
}
if(rangePercent){var range=el('span','band-range');range.style.left=rangePercent.left.toFixed(2)+'%';range.style.width=rangePercent.width.toFixed(2)+'%';put(track,range);}
else{track.className+=' band-track--empty';}
if(midPercent!==null){var mid=el('span','band-mid');mid.style.left=midPercent.toFixed(2)+'%';put(track,mid);}
var text;if(positive(row.lowUsd)&&positive(row.highUsd)){text=usd(row.lowUsd)+'–'+usd(row.highUsd);}
else{text='No band supplied';}
put(td,track,el('span','band-text',text));td.dataset.label='Empirical band';return td;}
function createEvidenceCell(row){var td=el('td','col-evidence cell-evidence');var evidence=el('div','evidence'+(row.flags.length?' evidence--flagged':''));put(evidence,el('span','evidence-dot'));var textWrap=el('span');var countLabel=row.flags.length===0?'Clear':row.flags.length+(row.flags.length===1?' flag':' flags');put(textWrap,el('span','evidence-label',countLabel));if(row.flags.length>0){var sub=flagLabel(row.flags[0]);if(row.flags.length>1)sub+=' +'+(row.flags.length-1)+' more';put(textWrap,el('span','evidence-sub',sub));}
else if(row.tokenStatus){put(textWrap,el('span','evidence-sub',row.tokenStatus));}
put(evidence,textWrap);put(td,evidence);td.dataset.label='Evidence';return td;}
function buildRow(row){var tr=document.createElement('tr');tr.dataset.slug=row.slug;var rank=el('td','col-rank cell-rank',row.rank===null?'—':'#'+row.rank);put(tr,rank);var nameCell=el('td','col-name cell-name');var link=el('a','name-link',row.name);link.href='#/protocol/'+encodeURIComponent(row.slug);link.setAttribute('aria-label','View valuation detail for '+row.name);put(nameCell,link);var meta=el('div','name-meta');put(meta,el('span',null,row.slug));if(row.chains.length){var chainText=row.chains.slice(0,2).join(' · ');if(row.chains.length>2)chainText+=' +'+(row.chains.length-2);put(meta,el('span',null,chainText));}
if(row.watchlist)meta.appendChild(el('span','watch','Watched'));put(nameCell,meta);put(tr,nameCell);tr.appendChild(el('td','col-category cell-category'+(row.category?'':' cell-empty'),row.category||'Uncategorized'));put(tr,el('td','col-tvl cell-tvl num cell-num',usd(row.tvlUsd)));var change=el('td','col-change cell-change num cell-num'+(finite(row.change7d)?' '+changeClass(row.change7d):' cell-empty'),formatChange(row.change7d));put(tr,change);tr.appendChild(el('td','col-implied cell-implied num cell-num cell-implied-value',usd(row.impliedValueUsd)));put(tr,createBandCell(row));tr.appendChild(el('td','col-peers cell-peers num cell-num',finite(row.peerCount)?fmtCount(row.peerCount):'—'));put(tr,createEvidenceCell(row));return tr;}
function updateLedger(announce){if(!ledger||!ledger.tbody)return;var filtered=sortedFilteredRows();var totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));if(state.page>totalPages)state.page=totalPages;if(state.page<1)state.page=1;var start=(state.page-1)*PAGE_SIZE;var pageRows=filtered.slice(start,start+PAGE_SIZE);var fragment=document.createDocumentFragment();pageRows.forEach(function(row){put(fragment,buildRow(row));}
);ledger.tbody.replaceChildren(fragment);ledger.resultCount.textContent=filtered.length+' of '+rows.length+' protocols · sorted by '+sortDescription();var isEmpty=filtered.length===0;ledger.tableWrap.hidden=isEmpty;ledger.empty.hidden=!isEmpty;ledger.pager.hidden=isEmpty||totalPages<=1;if(isEmpty){ledger.emptyText='The full snapshot holds '+rows.length+' protocols. Clear a filter or search a different name.';var emptyParagraph=ledger.empty.querySelector('p');if(emptyParagraph)emptyParagraph.textContent=ledger.emptyText;}
ledger.pagerLabel.textContent='Page '+state.page+' of '+totalPages;ledger.prev.disabled=state.page<=1;ledger.next.disabled=state.page>=totalPages;updateSortIndicators();if(announce){announcer.textContent=isEmpty?'No protocols match these filters.':filtered.length+' protocols match. Page '+state.page+' of '+totalPages+'.';}
}
function resetAll(){state.query='';state.category='all';state.watchlistOnly=false;state.evidence='all';state.sortKey='rank';state.sortDir='asc';state.page=1;syncControls();updateLedger(true);if(ledger&&ledger.searchInput)ledger.searchInput.focus();}
function buildFactList(row){var dl=el('dl','facts');function fact(term,value,className){put(dl,el('dt',null,term),el('dd',className||null,value));}
fact('Category',row.category||'Uncategorized');fact('Chains',row.chains.length?row.chains.join(' · '):'Not supplied');fact('TVL',usdFull(row.tvlUsd));fact('7d change',formatChange(row.change7d));fact('Listed at',row.listedAt||'Not supplied');fact('Peer examples',finite(row.peerCount)?fmtCount(row.peerCount):'Not supplied');fact('Token status',row.tokenStatus||'Not supplied');fact('Watchlist',row.watchlist?'Watched':'Not watched',row.watchlist?'watch':null);return dl;}
function buildFlags(row){if(row.flags.length===0){return el('p','section-note','No evidence flags were recorded for this protocol.');}
var list=el('ul','flags');row.flags.forEach(function(flag){var item=el('li');put(item,el('span','flag-dot'));put(item,el('span',null,flagLabel(flag)));put(list,item);}
);return list;}
function buildPeers(row){var section=el('section');put(section,el('h2',null,'Peer comparison'));var note=row.peers.length?'Source peers from the frozen snapshot; examples are not a recommendation.':'No peer examples were supplied for this row.';put(section,el('p','section-note',note));if(row.peers.length===0)return section;var table=el('table','peers');var caption=el('caption','sr-only','Peer market-cap comparison for '+row.name);put(table,caption);var thead=el('thead');var headerRow=el('tr');put(headerRow,el('th',null,'Peer'),el('th','num','TVL'),el('th','num','Market cap'),el('th','num','MC / TVL'));put(thead,headerRow);put(table,thead);var tbody=el('tbody');row.peers.forEach(function(peer){var tr=el('tr');var ratio=positive(peer.marketCapUsd)&&positive(peer.tvlUsd)?(peer.marketCapUsd/peer.tvlUsd).toFixed(2)+'×':'—';put(tr,el('td','peer-slug',peer.slug),el('td','num',usd(peer.tvlUsd)),el('td','num',usd(peer.marketCapUsd)),el('td','num',ratio));put(tbody,tr);}
);put(table,tbody);put(section,table);if(finite(row.peerCount)&&row.peerCount>row.peers.length){section.appendChild(el('p','section-note','Showing '+row.peers.length+' of '+fmtCount(row.peerCount)+' peers in this build.'));}
return section;}
function buildFarm(row){var section=el('section');put(section,el('h2',null,'Farm checks'));if(!row.farm){section.appendChild(el('p','section-note','No farm evidence supplied; no checks are inferred.'));return section;}
var statusText=FARM_STATUS_LABELS[row.farm.status]||sentenceCase(row.farm.status.replace(/-/g,' '))||'Status not supplied';var status=el('p','farm-status farm-status--'+(row.farm.status||'research-only'),statusText);put(section,status);section.appendChild(el('p','section-note','Status is shown as supplied by the generated snapshot. This page makes no remote calls and verifies no terms.'));var stepsBlock=el('div','farm-block');put(stepsBlock,el('h3',null,'Steps'));if(row.farm.steps.length){var list=el('ol','farm-steps');row.farm.steps.forEach(function(step){put(list,el('li',null,step));}
);put(stepsBlock,list);}
else{put(stepsBlock,el('p','section-note','No farm steps were supplied.'));}
put(section,stepsBlock);var sourcesBlock=el('div','farm-block');put(sourcesBlock,el('h3',null,'Sources'));if(row.farm.sources.length){var sources=el('ul','farm-sources');row.farm.sources.forEach(function(source){put(sources,el('li',null,source));}
);put(sourcesBlock,sources);}
else{put(sourcesBlock,el('p','section-note','No source notes were supplied.'));}
put(section,sourcesBlock);return section;}
function buildBenchmarkContext(){var section=el('section');put(section,el('h2',null,'Held-out context'));var bench=data.benchmark;if(!(bench&&(has(bench.selected)||has(bench.category)||has(bench.global)))){section.appendChild(el('p','section-note','No held-out benchmark metrics were supplied.'));return section;}
var box=el('div','aside-note');var globalText=el('p');put(globalText,el('strong',null,'Global wide band. '));var globalParts=[];if(finite(bench.global.coverage)){globalParts.push('Covered '+formatCoverage(bench.global.coverage)+' of held-out peers');}
if(finite(bench.sampleN)){globalParts.push('n = '+fmtCount(bench.sampleN));}
if(finite(bench.global.medianAbsLogError)){globalParts.push('median absolute log error '+formatDecimal(bench.global.medianAbsLogError,2));}
globalText.appendChild(document.createTextNode(globalParts.length?globalParts.join(' · ')+'.':'Metrics were not supplied for the pooled baseline.'));put(box,globalText);var selectedText=el('p');var selectedParts=[];if(finite(bench.selected.coverage))selectedParts.push('coverage '+formatCoverage(bench.selected.coverage));if(finite(bench.selected.medianAbsLogError))selectedParts.push('median absolute log error '+formatDecimal(bench.selected.medianAbsLogError,2));var level=percentLevel(bench.intervalLevel);selectedText.textContent='Selected model'+(level?' at the '+level+' empirical level':'')+': '+(selectedParts.length?selectedParts.join(' · '):'no metrics supplied')+'.';put(box,selectedText);if(bench.label){put(box,el('p',null,bench.label));}
put(section,box);section.appendChild(el('p','section-note','This is a held-out cross-sectional comparison, not a launch backtest or a probability of future market cap.'));return section;}
function buildBandChart(row){var section=el('section','detail-band');section.setAttribute('aria-labelledby','band-title');var head=el('div','section-head');var title=el('h2',null,'Empirical valuation band');title.id='band-title';var legendText=[];var level=percentLevel(data.benchmark&&data.benchmark.intervalLevel);if(level)legendText.push(level+' interval');var multiple=formatMultiple(row.lowUsd,row.highUsd);if(multiple)legendText.push(multiple+' range');put(head,title,el('span',null,legendText.length?legendText.join(' · '):'Interval not supplied'));put(section,head);var domain=computeLocalDomain([row.lowUsd,row.highUsd]);var lowPos=bandPosition(row.lowUsd,domain);var highPos=bandPosition(row.highUsd,domain);var midPos=bandPosition(row.impliedValueUsd,domain);if(lowPos!==null&&highPos!==null){var chart=el('div','band-chart');var track=el('div','band-chart__track');var range=el('span','band-chart__range');range.style.left=Math.min(lowPos,highPos).toFixed(2)+'%';range.style.width=Math.max(1,Math.abs(highPos-lowPos)).toFixed(2)+'%';put(track,range);if(midPos!==null){var mid=el('span','band-chart__mid');mid.style.left=midPos.toFixed(2)+'%';put(track,mid);}
put(chart,track);var labels=el('div','band-chart__legend');var lowItem=el('span');put(lowItem,document.createTextNode('Low '),el('strong',null,usdFull(row.lowUsd)));var highItem=el('span');put(highItem,document.createTextNode('High '),el('strong',null,usdFull(row.highUsd)));put(labels,lowItem,highItem);put(chart,labels);put(section,chart);}
else{section.appendChild(el('p','section-note','No usable low and high values supplied, so no interval is drawn.'));}
section.appendChild(el('p','method-note','The vertical marker is the implied market cap. The band is an empirical interval derived from out-of-fold peer residuals. It is a cross-sectional benchmark, not a price forecast, launch backtest, or probability.'));return section;}
function renderDetailMissing(slug){var article=el('article','detail');var section=el('section','no-data');var title=el('h1',null,'Protocol not found');title.id='detail-title';title.tabIndex=-1;var back=el('a','back-link','← Back to ledger');back.href='#/';put(article,back,section);put(section,title,el('p',null,'No row with the slug “'+slug+'” is present in this snapshot.'));var again=el('a','back-link','Return to the valuation ledger');again.href='#/';put(section,again);app.replaceChildren(article);announcer.textContent='Protocol not found.';}
function renderDetail(slug){var row=rows.filter(function(item){return item.slug===slug;}
)[0];if(!row){renderDetailMissing(slug);return;}
var article=el('article','detail');var back=el('a','back-link','← Back to ledger');back.href='#/';put(article,back);var head=el('header','detail-head');var headMain=el('div');var title=el('h1','detail-title',row.name);title.id='detail-title';title.tabIndex=-1;put(headMain,title);var meta=el('p','detail-meta');put(meta,el('span',null,row.rank===null?'Rank not supplied':'Rank #'+row.rank),el('span',null,row.slug),el('span',null,row.category||'Uncategorized'),el('span',null,row.chains.length?row.chains.join(' · '):'Chains not supplied'));if(row.watchlist)meta.appendChild(el('span','watch','Watched'));put(headMain,meta);var value=el('div','detail-value');put(value,el('span','detail-value__label','Implied market cap'));put(value,el('strong',null,usdFull(row.impliedValueUsd)));var rangeText=positive(row.lowUsd)&&positive(row.highUsd)?usd(row.lowUsd)+' – '+usd(row.highUsd):'No empirical band supplied';put(value,el('span','detail-value__range',rangeText));put(head,headMain,value);put(article,head);put(article,buildBandChart(row));var columns=el('div','detail-columns');var main=el('div','detail-main');put(main,buildPeers(row));put(main,buildFarm(row));var aside=el('aside','detail-aside');var factsSection=el('section');put(factsSection,el('h2',null,'Snapshot facts'));put(factsSection,buildFactList(row));put(aside,factsSection);var evidenceSection=el('section');put(evidenceSection,el('h2',null,'Evidence'));evidenceSection.appendChild(el('p','section-note','Flags and token status are shown as supplied by the generated snapshot; this page does not score them.'));put(evidenceSection,buildFlags(row));put(aside,evidenceSection);put(aside,buildBenchmarkContext());put(columns,main,aside);put(article,columns);app.replaceChildren(article);announcer.textContent=row.name+' valuation detail.';}
function focusHeading(){var heading=app.querySelector('h1');if(heading)heading.focus({preventScroll:true}
);}
function isRouteHash(hash){return hash===''||hash==='#/'||hash.indexOf('#/protocol/')===0;}
function navigateTo(hash){if(location.hash!==hash){history.pushState(null,'',hash);}
handleRoute({initial:false}
);}
function handleRoute(options){var settings=options||{}
;var slug=null;if(location.hash.indexOf('#/protocol/')===0){slug=location.hash.slice(11);try{slug=decodeURIComponent(slug);}
catch(error){slug=location.hash.slice(11);}
}
var route=slug===null?'board':'detail:'+slug;if(route===lastRenderedRoute)return;lastRenderedRoute=route;var wasView=view;if(view==='board')lastBoardScroll=window.scrollY;if(slug!==null){view='detail';renderDetail(slug);window.scrollTo(0,0);if(!settings.initial)focusHeading();return;}
view='board';renderBoard();if(!settings.initial&&wasView==='detail'){window.scrollTo(0,lastBoardScroll);focusHeading();}
}
function init(){var raw=globalThis.TOKEN_RADAR_DATA;data=readData();if(!data){renderNoData(raw?'The generated data file has no readable rows. No valuation rows are shown.':null);return;}
rows=data.rows;bandDomain=buildBandDomain(rows);updateChrome();window.addEventListener('hashchange',function(){if(isRouteHash(location.hash))handleRoute({initial:false}
);}
);window.addEventListener('popstate',function(){if(isRouteHash(location.hash))handleRoute({initial:false}
);}
);document.addEventListener('click',function(event){if(!(event.target instanceof Element))return;var link=event.target.closest('a[href^="#/"]');if(!link)return;if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey){return;}
event.preventDefault();navigateTo(link.getAttribute('href'));}
);document.addEventListener('keydown',function(event){if(event.key==='Escape'&&location.hash.indexOf('#/protocol/')===0){event.preventDefault();navigateTo('#/');}
}
);handleRoute({initial:true}
);}
init();}
)();
