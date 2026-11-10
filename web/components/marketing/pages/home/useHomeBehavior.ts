// @ts-nocheck
// Ported verbatim from the page's previous inline script: it is DOM-animation
// code driven by data-step/data-progress attributes. Typing it properly is a
// follow-up; keeping it untyped here was chosen over rewriting the timing.

import { useEffect, type RefObject } from 'react'

export type HomeDemoCopy = {
  sidebarPrompt: string
  workflowPrompt: string
  workflowConfirmation: string
  detailTitle: string
  locale: string
}

/**
 * Home-page demos: the sidebar walkthrough, the workflow animation and the
 * card reveal. Ported from the page's inline script; the DOM contract
 * (data-step / data-progress attributes and class names) is unchanged.
 */
export function useHomeBehavior(rootRef: RefObject<HTMLElement | null>, copy: HomeDemoCopy) {
  useEffect(() => {
    const controller = new AbortController()
    const cleanups: Array<() => void> = []
    const host = rootRef.current
    if (!host) return
    const root = host

  const sidebarDemo = root.querySelector('.sidebar-demo');
      const sidebarInput = sidebarDemo.querySelector('.sidebar-input');
      const sidebarInputText = sidebarDemo.querySelector('.sidebar-input-text');
      const sidebarPrompt = copy.sidebarPrompt;
      const sidebarReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      let sidebarTimers: number[] = [];
      let sidebarVisible = false;
      const sidebarLater = (callback: () => void, delay: number) => sidebarTimers.push(window.setTimeout(callback,delay));
      const stopSidebarDemo = () => { sidebarTimers.forEach(window.clearTimeout); sidebarTimers = []; };
      const resetSidebarDemo = () => {
        stopSidebarDemo();
        sidebarDemo.dataset.step = 'idle';
        sidebarInputText.textContent = '';
        sidebarInput.classList.add('is-empty');
      };
      const startSidebarDemo = () => {
        if (!sidebarVisible) return;
        if (sidebarReducedMotion.matches) {
          stopSidebarDemo();
          sidebarDemo.dataset.step = 'product-b';
          sidebarInputText.textContent = '';
          sidebarInput.classList.add('is-empty');
          return;
        }
        resetSidebarDemo();
        sidebarLater(() => { sidebarDemo.dataset.step = 'open'; },1200);
        sidebarLater(() => {
          sidebarDemo.dataset.step = 'typing';
          sidebarInput.classList.remove('is-empty');
          let character = 0;
          const typeNext = () => {
            sidebarInputText.textContent = sidebarPrompt.slice(0,++character);
            if (character < sidebarPrompt.length) sidebarLater(typeNext,85);
          };
          typeNext();
        },2500);
        sidebarLater(() => {
          sidebarDemo.dataset.step = 'results';
          sidebarInputText.textContent = '';
          sidebarInput.classList.add('is-empty');
        },5900);
        sidebarLater(() => { sidebarDemo.dataset.step = 'tabs'; },6400);
        sidebarLater(() => { sidebarDemo.dataset.step = 'select-a'; },7200);
        sidebarLater(() => { sidebarDemo.dataset.step = 'product-a'; },8000);
        sidebarLater(() => { sidebarDemo.dataset.step = 'select-b'; },9200);
        sidebarLater(() => { sidebarDemo.dataset.step = 'product-b'; },10000);
        sidebarLater(startSidebarDemo,13000);
      };
      const sidebarObserver = new IntersectionObserver(([entry]) => {
        const wasVisible = sidebarVisible;
        sidebarVisible = entry.isIntersecting;
        if (sidebarVisible && !wasVisible) startSidebarDemo();
        else if (!sidebarVisible && wasVisible) resetSidebarDemo();
      },{ threshold:.35 });
      sidebarObserver.observe(sidebarDemo);
      cleanups.push(() => { sidebarObserver.disconnect(); stopSidebarDemo(); });
      sidebarReducedMotion.addEventListener('change',() => { if (sidebarVisible) startSidebarDemo(); }, { signal: controller.signal });
      const workflowDemo = root.querySelector('.workflow-demo');
      const workflowPromptText = workflowDemo.querySelector('.workflow-prompt-text');
      const workflowConfirmationText = workflowDemo.querySelector('.workflow-confirmation-text');
      const workflowInput = workflowDemo.querySelector('.workflow-input');
      const workflowSend = workflowDemo.querySelector('.workflow-send');
      const workflowChat = workflowDemo.querySelector('.workflow-chat');
      const workflowPrompt = copy.workflowPrompt;
      const workflowConfirmation = copy.workflowConfirmation;
      let workflowTimers: number[] = [];
      let workflowVisible = false;
      const workflowLater = (callback: () => void, delay: number) => workflowTimers.push(window.setTimeout(callback,delay));
      const stopWorkflowDemo = () => { workflowTimers.forEach(window.clearTimeout); workflowTimers = []; };
      const setWorkflowStage = (progress: number) => {
        workflowDemo.dataset.progress = String(progress);
        window.requestAnimationFrame(() => workflowChat.scrollTo({ top:workflowChat.scrollHeight,behavior:'smooth' }));
      };
      const resetWorkflowDemo = () => {
        stopWorkflowDemo();
        workflowDemo.dataset.progress = '0';
        workflowPromptText.textContent = '';
        workflowConfirmationText.textContent = '';
        workflowInput.value = '';
        workflowChat.scrollTop = 0;
      };
      const typeWorkflowMessage = (message: string, interval: number, onSend: () => void) => {
        let character = 0;
        workflowInput.value = '';
        const typeNext = () => {
          workflowInput.value = message.slice(0,++character);
          if (character < message.length) workflowLater(typeNext,interval);
          else workflowLater(onSend,280);
        };
        typeNext();
      };
      const startWorkflowDemo = () => {
        if (!workflowVisible) return;
        if (sidebarReducedMotion.matches) {
          stopWorkflowDemo();
          workflowDemo.dataset.progress = '9';
          workflowPromptText.textContent = workflowPrompt;
          workflowConfirmationText.textContent = workflowConfirmation;
          window.requestAnimationFrame(() => workflowChat.scrollTo({ top:workflowChat.scrollHeight,behavior:'auto' }));
          return;
        }
        resetWorkflowDemo();
        typeWorkflowMessage(workflowPrompt,125,() => {
          workflowPromptText.textContent = workflowInput.value;
          workflowInput.value = '';
          setWorkflowStage(1);
          workflowLater(() => setWorkflowStage(2),1100);
          workflowLater(() => setWorkflowStage(3),3300);
          workflowLater(() => setWorkflowStage(4),5500);
          workflowLater(() => setWorkflowStage(5),11000);
          workflowLater(() => setWorkflowStage(6),14000);
          workflowLater(() => typeWorkflowMessage(workflowConfirmation,125,() => {
            workflowConfirmationText.textContent = workflowInput.value;
            workflowInput.value = '';
            setWorkflowStage(7);
            workflowLater(() => setWorkflowStage(8),1700);
            workflowLater(() => {
              setWorkflowStage(9);
              workflowLater(startWorkflowDemo,5000);
            },3600);
          }),17000);
        });
      };
      workflowSend.addEventListener('click',() => { if (workflowVisible) startWorkflowDemo(); });
      const workflowObserver = new IntersectionObserver(([entry]) => {
        const wasVisible = workflowVisible;
        workflowVisible = entry.isIntersecting;
        if (workflowVisible && !wasVisible) startWorkflowDemo();
        else if (!workflowVisible && wasVisible) resetWorkflowDemo();
      },{ threshold:.25 });
      workflowObserver.observe(workflowDemo);
      cleanups.push(() => { workflowObserver.disconnect(); stopWorkflowDemo(); });
      sidebarReducedMotion.addEventListener('change',() => { if (workflowVisible) startWorkflowDemo(); }, { signal: controller.signal });
      root.querySelectorAll('[data-future-link]').forEach((link: HTMLElement) => {
        link.addEventListener('click',(event: Event) => event.preventDefault());
        link.title = copy.detailTitle;
      });
      const scenarioTabs = [...root.querySelectorAll('.scenario-tab')];
      const selectScenarioTab = (selectedTab: Element) => {
        scenarioTabs.forEach((tab) => {
          const isSelected = tab === selectedTab;
          tab.setAttribute('aria-selected',String(isSelected));
          tab.tabIndex = isSelected ? 0 : -1;
          const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
          if (panel) panel.hidden = !isSelected;
        });
      };
      scenarioTabs.forEach((tab,index) => {
        tab.addEventListener('click',() => selectScenarioTab(tab));
        tab.addEventListener('keydown',(event: KeyboardEvent) => {
          let nextIndex;
          if (event.key === 'ArrowRight') nextIndex = (index + 1) % scenarioTabs.length;
          else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + scenarioTabs.length) % scenarioTabs.length;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = scenarioTabs.length - 1;
          else return;
          event.preventDefault();
          selectScenarioTab(scenarioTabs[nextIndex]);
          scenarioTabs[nextIndex].focus();
        });
      });
      const resultTable = root.querySelector<HTMLTableElement>('.result-trend .result-table');
      if (!resultTable) return
      const resultPlot = root.querySelector<SVGSVGElement>('.result-chart svg');
      if (!resultPlot) return
      const resultNet = root.querySelector<HTMLElement>('[data-result-net]');
      if (!resultNet) return
      const resultPanel = root.querySelector('.result-panel');
      const resultObserver = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        resultPanel.classList.add('is-in-view');
        resultObserver.disconnect();
      },{ threshold:.2 });
      resultObserver.observe(resultPanel);
      cleanups.push(() => resultObserver.disconnect());
      const renderResultChart = () => {
        const rows = [...resultTable.tBodies[0].rows].slice(1);
        const records = rows.map((row) => {
          const cells = row.querySelectorAll('td');
          return {
            inbound:Number(cells[1]?.textContent.replace(/,/g,'').trim()),
            outbound:Number(cells[2]?.textContent.replace(/,/g,'').trim())
          };
        }).filter((item) => Number.isFinite(item.inbound) && Number.isFinite(item.outbound));
        if (!records.length) {
          resultPlot.replaceChildren();
          resultNet.textContent = '—';
          return;
        }
        const netValue = records.reduce((total,item) => total + item.inbound - item.outbound,0);
        resultNet.textContent = (netValue >= 0 ? '+' : '') + netValue.toLocaleString(copy.locale);
        const values = records.flatMap((item) => [item.inbound,item.outbound]);
        const maxValue = Math.max(...values);
        const minValue = Math.min(...values);
        const scaleMin = Math.max(0,Math.floor(minValue / 100) * 100);
        const scaleMax = Math.max(scaleMin + 300,Math.ceil((maxValue + 1) / 100) * 100);
        const xAt = (index: number) => 42 + index * 296 / Math.max(1,records.length - 1);
        const yAt = (value: number) => 156 - (value - scaleMin) / (scaleMax - scaleMin) * 130;
        const inbound = records.map((item: { inbound: number; outbound: number }, index: number) => ({ x:xAt(index),y:yAt(item.inbound) }));
        const outbound = records.map((item: { inbound: number; outbound: number }, index: number) => ({ x:xAt(index),y:yAt(item.outbound) }));
        const smoothPath = (points: Array<{ x: number; y: number }>) => points.map((point, index) => {
          if (!index) return 'M' + point.x.toFixed(1) + ' ' + point.y.toFixed(1);
          const previous = points[index - 1];
          const before = points[index - 2] || previous;
          const next = points[index + 1] || point;
          const firstX = previous.x + (point.x - before.x) / 6;
          const firstY = previous.y + (point.y - before.y) / 6;
          const secondX = point.x - (next.x - previous.x) / 6;
          const secondY = point.y - (next.y - previous.y) / 6;
          return 'C' + firstX.toFixed(1) + ' ' + firstY.toFixed(1) + ' ' + secondX.toFixed(1) + ' ' + secondY.toFixed(1) + ' ' + point.x.toFixed(1) + ' ' + point.y.toFixed(1);
        }).join(' ');
        const inboundPath = smoothPath(inbound);
        const outboundPath = smoothPath(outbound);
        const tickStep = Math.max(100,Math.round((scaleMax - scaleMin) / 300) * 100);
        const ticks = Array.from({ length:4 },(_,index) => scaleMax - index * tickStep).filter((value) => value >= scaleMin);
        const grid = ticks.map((value) => {
          const y = yAt(value);
          return '<path d="M39 ' + y.toFixed(1) + 'H338" fill="none" stroke="#e0eee6" stroke-width=".8"/><text x="32" y="' + (y + 3).toFixed(1) + '" fill="#91a99a" font-size="9" text-anchor="end">' + Math.round(value) + '</text>';
        }).join('');
        const peakIndex = records.reduce((best,item,index) => item.inbound > records[best].inbound ? index : best,0);
        const peak = inbound[peakIndex];
        resultPlot.innerHTML = '<defs><linearGradient id="result-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#35c87d" stop-opacity=".16"/><stop offset="1" stop-color="#35c87d" stop-opacity="0"/></linearGradient><linearGradient id="result-chart-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#29bd75"/><stop offset="1" stop-color="#098f57"/></linearGradient><filter id="result-chart-glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter><filter id="result-chart-dot-shadow" x="-100%" y="-100%" width="300%" height="300%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#287b54" flood-opacity=".22"/></filter></defs>'
          + grid
          + '<path d="' + inboundPath + ' L338 156 L42 156 Z" fill="url(#result-chart-fill)"/>'
          + '<path d="M' + peak.x.toFixed(1) + ' ' + (peak.y + 7).toFixed(1) + 'V154" fill="none" stroke="#54b785" stroke-opacity=".5" stroke-width="1" stroke-dasharray="1 4" stroke-linecap="round"/>'
          + '<path class="result-chart-line" d="' + outboundPath + '" fill="none" stroke="#90d6ad" stroke-width="1.8" stroke-linecap="round"/>'
          + '<path class="result-chart-line" d="' + inboundPath + '" fill="none" stroke="#15a96a" stroke-width="5" stroke-linecap="round" opacity=".22" filter="url(#result-chart-glow)"/>'
          + '<path class="result-chart-line" d="' + inboundPath + '" fill="none" stroke="url(#result-chart-line)" stroke-width="2.3" stroke-linecap="round"/>'
          + '<circle class="result-chart-peak" cx="' + peak.x.toFixed(1) + '" cy="' + peak.y.toFixed(1) + '" r="5.5" fill="#fff" filter="url(#result-chart-dot-shadow)"/><circle class="result-chart-peak" cx="' + peak.x.toFixed(1) + '" cy="' + peak.y.toFixed(1) + '" r="3.5" fill="#2bbd7b"/>';
      };
      renderResultChart();
      new MutationObserver(renderResultChart).observe(resultTable.tBodies[0],{ childList:true,characterData:true,subtree:true });

    return () => {
      controller.abort()
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [rootRef, copy])
}
