/* Code & Blocks MCP Bridge – live notices via Heartbeat. Author: Code & Blocks by Marijan */
(function ($) {
	if (typeof cbmcpLive === 'undefined' || !window.wp || !wp.heartbeat) return;
	var since = parseInt(cbmcpLive.since, 10) || 0;
	var t = cbmcpLive.i18n;
	var box;

	function container() {
		if (!box) {
			box = document.createElement('div');
			box.className = 'cbmcp-toasts';
			box.setAttribute('role', 'status');
			box.setAttribute('aria-live', 'polite');
			document.body.appendChild(box);
		}
		return box;
	}

	function link(href, label, blank) {
		var a = document.createElement('a');
		a.href = href;
		a.textContent = label;
		if (blank) { a.target = '_blank'; a.rel = 'noopener'; }
		return a;
	}

	function show(e) {
		var el = document.createElement('div');
		el.className = 'cbmcp-toast' + (e.status === 'error' ? ' err' : '') + (e.kind === 'approval' ? ' approval' : '');
		var close = document.createElement('button');
		close.type = 'button';
		close.setAttribute('aria-label', t.dismiss);
		close.textContent = '×';
		close.onclick = function () { el.remove(); };
		var title = document.createElement('strong');
		title.textContent = t.title;
		var text = document.createElement('div');
		text.textContent = e.summary;
		var links = document.createElement('div');
		if (e.link) links.appendChild(link(e.link, e.kind === 'approval' ? t.approve : t.view, true));
		if (e.edit_link) links.appendChild(link(e.edit_link, t.edit));
		links.appendChild(link(cbmcpLive.activity, t.all));
		el.append(close, title, text, links);
		container().appendChild(el);
		if (e.kind !== 'approval') setTimeout(function () { el.remove(); }, 15000);
		var badge = document.querySelector('#wp-admin-bar-cbmcp-activity .ab-label');
		if (badge) {
			var c = badge.querySelector('.cbmcp-count');
			if (!c) { c = document.createElement('span'); c.className = 'cbmcp-count'; c.textContent = '0'; badge.appendChild(c); }
			c.textContent = String((parseInt(c.textContent, 10) || 0) + 1);
		}
	}

	if (wp.heartbeat.interval() > 30) wp.heartbeat.interval(30);
	$(document).on('heartbeat-send', function (_e, data) { data.cbmcp_since = since; });
	$(document).on('heartbeat-tick', function (_e, data) {
		if (!data || !data.cbmcp) return;
		data.cbmcp.forEach(function (e) {
			since = Math.max(since, e.id);
			show(e);
		});
	});
})(jQuery);
