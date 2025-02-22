/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Mode } from '@recorder/recorderTypes';
import type { CrxApplication } from 'playwright-crx';
import playwright, { crx, registerSourceMap, _debug, _setUnderTest } from 'playwright-crx';
import posthog from 'posthog-js'

// Safe PostHog tracking wrapper
const analytics = {
  init: () => {
    try {
      posthog.init('phc_6aJLwW6H2Br5eIvmkHp4ucruc0ARVAQKSts8epprVLw', {
        api_host: 'https://d3i24tnd0dzgfi.cloudfront.net',
        ui_host: 'https://us.i.posthog.com',
        person_profiles: 'identified_only', // or 'always' to create profiles for anonymous users as well

        persistence: 'localStorage',
        autocapture: false,
        capture_pageview: false,
        capture_performance: true,
        bootstrap: {
          distinctID: chrome.runtime.id,
          isIdentifiedID: true
        }
      });

      // Identify the installation
      posthog.identify(chrome.runtime.id, {
        app_name: 'Playwright Recorder',
        extension_version: chrome.runtime.getManifest().version,
        browser: navigator.userAgent,
        platformInfo: (navigator as any).userAgentData?.platform || navigator.platform,
        language: navigator.language,
      });
    } catch (error) {
      console.error('PostHog initialization failed:', error);
    }
  },

  capture: (eventName: string, properties: any = {}) => {
    try {
      // Add common properties to all events
      const enrichedProperties = {
        ...properties,
        app_name: 'Playwright Recorder',
        timestamp: new Date().toISOString(),
        extension_version: chrome.runtime.getManifest().version,
        browser_info: navigator.userAgent,
        memory_usage: (performance as any)?.memory?.usedJSHeapSize || undefined,
        attached_tabs_count: attachedTabIds.size,
        current_mode: currentMode,
        language: language
      };

      posthog.capture(eventName, enrichedProperties);
    } catch (error) {
      console.error(`PostHog event capture failed for ${eventName}:`, error);
      throw error
    }
  }
};

// Initialize PostHog
analytics.init();

registerSourceMap().catch(() => { });

type CrxMode = Mode | 'detached';

const stoppedModes: CrxMode[] = ['none', 'standby', 'detached'];
const recordingModes: CrxMode[] = ['recording', 'assertingText', 'assertingVisibility', 'assertingValue', 'assertingSnapshot'];

// we must lazy initialize it
let crxAppPromise: Promise<CrxApplication> | undefined;

const attachedTabIds = new Set<number>();
let currentMode: CrxMode | 'detached' | undefined;
let language: string | undefined;
let sidepanel = true;
let lastModeChangeTime: number | undefined;
const tabAttachTimes = new Map<number, number>();

async function changeAction(tabId: number, mode?: CrxMode | 'detached') {
  if (!mode) {
    mode = attachedTabIds.has(tabId) ? currentMode : 'detached';
  } else if (mode !== 'detached') {
    currentMode = mode;
  }

  // detached basically implies recorder windows was closed
  if (!mode || stoppedModes.includes(mode)) {
    await Promise.all([
      chrome.action.setTitle({ title: mode === 'none' ? 'Stopped' : 'Record', tabId }),
      chrome.action.setBadgeText({ text: '', tabId }),
    ]).catch(() => { });
    return;
  }

  const { text, title, color, bgColor } = recordingModes.includes(mode) ?
    { text: 'REC', title: 'Recording', color: 'white', bgColor: 'darkred' } :
    { text: 'INS', title: 'Inspecting', color: 'white', bgColor: 'dodgerblue' };

  await Promise.all([
    chrome.action.setTitle({ title, tabId }),
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeTextColor({ color, tabId }),
    chrome.action.setBadgeBackgroundColor({ color: bgColor, tabId }),
  ]).catch(() => { });
}

// action state per tab is reset every time a navigation occurs
// https://bugs.chromium.org/p/chromium/issues/detail?id=1450904
chrome.tabs.onUpdated.addListener(tabId => changeAction(tabId));

async function getCrxApp() {
  if (!crxAppPromise) {
    const { testIdAttributeName, targetLanguage } = await chrome.storage.sync.get(['testIdAttributeName', 'targetLanguage']);

    crxAppPromise = crx.start().then(crxApp => {
      crxApp.recorder.addListener('hide', async () => {
        await crxApp.detachAll();
      });
      crxApp.recorder.addListener('modechanged', async ({ mode }) => {
        await Promise.all([...attachedTabIds].map(tabId => changeAction(tabId, mode)));
        analytics.capture('recorder_mode_changed', {
          mode,
          previous_mode: currentMode,
          duration_in_previous_mode: currentMode ? Date.now() - (lastModeChangeTime || Date.now()) : 0
        });

        // Track recording start/stop events
        const wasRecording = recordingModes.includes(currentMode as CrxMode);
        const isRecording = recordingModes.includes(mode);

        if (!wasRecording && isRecording) {
          analytics.capture('recording_started', {
            from_mode: currentMode,
            attached_tabs: Array.from(attachedTabIds)
          });
        } else if (wasRecording && !isRecording) {
          analytics.capture('recording_stopped', {
            to_mode: mode,
            duration: Date.now() - (lastModeChangeTime || Date.now()),
            attached_tabs: Array.from(attachedTabIds)
          });
        }

        lastModeChangeTime = Date.now();
      });
      crxApp.addListener('attached', async ({ tabId }) => {
        attachedTabIds.add(tabId);
        await changeAction(tabId, crxApp.recorder.mode);
        const currentTab = await chrome.tabs.get(tabId);
        analytics.capture('recorder_attached', {
          tabId,
          url: currentTab?.url,
          title: currentTab?.title,
          window_id: currentTab?.windowId,
          is_incognito: currentTab?.incognito,
          tab_status: currentTab?.status,
          tab_index: currentTab?.index
        });
      });
      crxApp.addListener('detached', async tabId => {
        attachedTabIds.delete(tabId);
        await changeAction(tabId, 'detached');
        analytics.capture('recorder_detached', {
          tabId,
          reason: 'user_initiated',
          session_duration: Date.now() - (tabAttachTimes.get(tabId) || Date.now())
        });
        tabAttachTimes.delete(tabId);
      });
      if (!testIdAttributeName)
        setTestIdAttributeName(testIdAttributeName);
      if (!language && targetLanguage)
        language = targetLanguage;

      return crxApp;
    });
  }

  return await crxAppPromise;
}

async function attach(tab: chrome.tabs.Tab, mode?: Mode) {
  if (!tab?.id || (attachedTabIds.has(tab.id) && !mode)) return;
  const tabId = tab.id;

  // we need to open sidepanel before any async call
  if (sidepanel)
    chrome.sidePanel.open({ windowId: tab.windowId });

  // ensure one attachment at a time
  chrome.action.disable();

  const crxApp = await getCrxApp();

  try {
    if (crxApp.recorder.isHidden()) {
      await crxApp.recorder.show({
        mode: mode ?? 'recording',
        language,
        window: { type: sidepanel ? 'sidepanel' : 'popup', url: 'index.html' },
      });
    }

    await crxApp.attach(tabId);
    if (mode)
      await crxApp.recorder.setMode(mode);
  } catch (e) {
    // we just open a new page and attach it
    await crxApp.newPage();
  } finally {
    chrome.action.enable();
  }
}

async function setTestIdAttributeName(testIdAttributeName: string) {
  playwright.selectors.setTestIdAttribute(testIdAttributeName);
}

chrome.action.onClicked.addListener(attach);

chrome.contextMenus.create({
  id: 'pw-recorder',
  title: 'Attach to Playwright Recorder',
  contexts: ['all'],
});

chrome.contextMenus.onClicked.addListener(async (_, tab) => {
  if (tab) await attach(tab);
});

// if it's in sidepanel mode, we need to open it synchronously on action click,
// so we need to fetch its value asap
chrome.storage.sync.get(['sidepanel']).then(({ sidepanel: value }) => {
  if (value !== undefined)
    sidepanel = value;
});

chrome.storage.sync.onChanged.addListener(async ({ testIdAttributeName, targetLanguage, sidepanel: sidepanelChange }) => {
  if (testIdAttributeName)
    await setTestIdAttributeName(testIdAttributeName.newValue);
  if (targetLanguage)
    language = targetLanguage.newValue;
  if (sidepanelChange.newValue !== undefined)
    sidepanel = sidepanelChange.newValue;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab.id) return;
  if (command === 'inspect')
    await attach(tab, 'inspecting');
  else if (command === 'record')
    await attach(tab, 'recording');
});

async function doSave(params: { body: string, suggestedName: string }) {
  const crxApp = await getCrxApp();
  const currMode = crxApp.recorder.mode;
  await crxApp.recorder.setMode('none');

  // to avoid playwright from interfering too much, we use chrome tabs api to open and wait for the tab to close
  // and only attach playwright to click the link (showSaveFilePicker requires a user gesture)
  const saveTab = await chrome.tabs.create({ url: chrome.runtime.getURL('saving.html') });
  const closePromise = new Promise<void>(async resolve => {
    const tabClosed = (tabId: number) => {
      if (tabId === saveTab.id) {
        chrome.tabs.onRemoved.removeListener(tabClosed);
        resolve();
      }
    };
    chrome.tabs.onRemoved.addListener(tabClosed);
  });

  const page = await crxApp.attach(saveTab.id!);
  const elem = page.getByRole('link');
  await elem.evaluateHandle(async (elem, { body, suggestedName }) => {
    const handler = async () => {
      elem.removeEventListener('click', handler);
      try {
        const fileHandle = await showSaveFilePicker({ suggestedName });
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        await writable.write(body);
        await writable.close();
      } catch (e) {
        // not much we can do here
      }

      window.close();
    };
    elem.addEventListener('click', handler);
  }, params);

  await elem.click();
  await crxApp.detach(page);
  await closePromise;

  await crxApp.recorder.setMode(currMode);
}

async function saveScript(params: { code: string, suggestedName: string }) {
  await doSave({ body: params.code, suggestedName: params.suggestedName });
  analytics.capture('script_saved', {
    fileName: params.suggestedName,
    codeLength: params.code.length,
    fileExtension: params.suggestedName.split('.').pop(),
    containsAssertions: params.code.includes('expect') || params.code.includes('assert'),
    linesOfCode: params.code.split('\n').length,
    hasComments: params.code.includes('//') || params.code.includes('/*'),
    commandCount: (params.code.match(/\.(click|type|fill|select|check|uncheck|press)/g) || []).length
  });
}

async function saveStorageState() {
  const crxApp = await crxAppPromise;
  if (!crxApp)
    return;

  const { cookies: allCookies, origins } = await crxApp.context().storageState();
  const urls = Array.from(new Set(crxApp.pages().flatMap(p => [p.url(), ...p.frames().map(f => f.url())])));
  const parsedURLs = urls.map(s => new URL(s));
  const cookies = allCookies.filter(c => {
    if (!parsedURLs.length)
      return true;
    for (const parsedURL of parsedURLs) {
      let domain = c.domain;
      if (!domain.startsWith('.'))
        domain = '.' + domain;
      if (!('.' + parsedURL.hostname).endsWith(domain))
        continue;
      if (!parsedURL.pathname.startsWith(c.path))
        continue;
      if (parsedURL.protocol !== 'https:' && parsedURL.hostname !== 'localhost' && c.secure)
        continue;
      return true;
    }
    return false;
  });
  const storageState = { cookies, origins };

  await doSave({
    body: JSON.stringify(storageState, undefined, 2),
    suggestedName: 'storageState.json',
  });

  analytics.capture('storage_state_saved', {
    cookiesCount: cookies.length,
    originsCount: origins.length,
    domains: cookies.map(c => c.domain),
    urlsCount: urls.length,
    uniqueHostnames: Array.from(new Set(parsedURLs.map(u => u.hostname))).length
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.event === 'saveRequested')
    saveScript(message.params).catch(() => { });
  else if (message.event === 'saveStorageStateRequested')
    saveStorageState().catch(() => { });
});

// for testing
Object.assign(self, { attach, setTestIdAttributeName, _debug, _setUnderTest });
