"""Browser ESM integration without network: original actual parser.js loaded as a
Blob ES module; actual script.js import specifier is rebased to that blob URL.
Final DOM/CSS are the exact authored index.html and style.css.
No real user save is stored in this distributable test.
Usage:
 python tests/test_browser_native_modules.py /path/to/steam/save_0.save /path/to/switch/save_0.save
"""
from __future__ import annotations
import sys, json, tempfile, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SRC = [Path(p) for p in sys.argv[1:]]
assert len(SRC) == 2 and all(p.is_file() for p in SRC), "Need Steam and Switch fixture paths"
raw_html = (ROOT / 'index.html').read_text(encoding='utf-8')
css = (ROOT / 'style.css').read_text(encoding='utf-8')
parser = (ROOT / 'parser.js').read_text(encoding='utf-8')
script = (ROOT / 'script.js').read_text(encoding='utf-8')
html = raw_html.replace('<link rel="stylesheet" href="style.css">', '<style>' + css + '</style>')
html = html.replace('<script type="module" src="script.js"></script>', '')
assert html != raw_html
assert script.count('from "./parser.js"') == 1

result = {'native_esm_loaded': False,'actual_save_downloads': 0,'slot_preserved': False,'filename_independent_conversion': False,'original_name_preserved': False,'legacy_alias_removed': False,'bad_input_rejected': False,'missing_lz4_rejected_on_download': False,'drag_drop': False,'ui_colors': {}, 'notice_theme_checks':{}, 'notice_reset':False,'pageerrors': []}

with sync_playwright() as play:
    chromium_path = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
    launch = {'headless': True}
    if chromium_path:
        launch['executable_path'] = chromium_path
    if sys.platform.startswith('linux'):
        launch['args'] = ['--no-sandbox', '--disable-dev-shm-usage']
    browser = play.chromium.launch(**launch)
    page = browser.new_page(viewport={'width':1440,'height':900}, accept_downloads=True)
    page.on('pageerror', lambda e: result['pageerrors'].append(str(e)))
    page.set_content(html)
    # Blob modules resolve imports through the browser ES module loader; no text
    # concatenation or runtime source-code substitution other than the URL specifier.
    boot = '''async ({parser,script})=>{
      const blob = (src)=>URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
      const parserURL=blob(parser);
      const scriptURL=blob(script.replace('from "./parser.js"','from "'+parserURL+'"'));
      window.__realParser = await import(parserURL);
      await import(scriptURL);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      return !!window.__realParser.patchSavePlatform;
    }'''
    assert page.evaluate(boot, {'parser':parser,'script':script})
    result['native_esm_loaded'] = True
    assert page.locator('#idleView').is_visible()

    def send(data:bytes,name='save_0.save'):
        page.locator('#fileInput').set_input_files([{'name':name,'mimeType':'application/octet-stream','buffer':data}])
        page.locator('#successView').wait_for(state='visible',timeout=30000)
        assert page.locator('#conversionFeedback').is_hidden()
    expected={'steam':{'switch':'rgb(214, 47, 73)','apple':'rgb(236, 127, 177)','ps5':'rgb(143, 99, 201)'},
              'switch':{'steam':'rgb(88, 191, 230)','apple':'rgb(236, 127, 177)','ps5':'rgb(143, 99, 201)'}}
    for raw,source in zip(SRC,('steam','switch')):
        send(raw.read_bytes())
        assert page.locator('#downloadButtons .destination-button').count()==3
        for target,color in expected[source].items():
            sel=f'.destination--{target}'
            button=page.locator(sel)
            assert button.is_enabled(),f'{source}->{target} disabled'
            val=button.evaluate('(el)=>getComputedStyle(el).backgroundColor')
            result['ui_colors'][f'{source}->{target}']=val
            assert val==color,(source,target,val,color)
            with page.expect_download(timeout=60000) as entry:
                button.click()
            download=entry.value
            notice=page.locator('#conversionFeedback')
            assert notice.is_visible(),f'{source}->{target}: no status notice'
            assert notice.get_attribute('role')=='status'
            assert notice.get_attribute('aria-live')=='polite'
            assert f'feedback--{target}' in (notice.get_attribute('class') or '')
            assert notice.locator('.feedback-heading').inner_text() == f'{button.locator(".destination-name").inner_text()} download started'
            assert notice.locator('.feedback-filename').inner_text() == 'save_0.save'
            assert notice.evaluate('(el)=>getComputedStyle(el).borderLeftWidth')=='5px'
            assert notice.evaluate('(el)=>getComputedStyle(el).fontSize')=='14px'
            label_rgb=notice.locator('.feedback-heading').evaluate('(el)=>getComputedStyle(el).color')
            theme_colors={'steam':'rgb(19, 121, 159)','switch':'rgb(170, 32, 56)','apple':'rgb(172, 40, 105)','ps5':'rgb(108, 57, 169)'}
            assert label_rgb==theme_colors[target],(target,label_rgb)
            result['notice_theme_checks'][f'{source}->{target}']=label_rgb
            expected_name='save_0.save'
            assert download.suggested_filename==expected_name,(download.suggested_filename,expected_name)
            with tempfile.TemporaryDirectory() as d:
                out=Path(d) / expected_name
                download.save_as(out)
                data=out.read_bytes()
                assert page.evaluate('(b)=>window.__realParser.parseSave(new Uint8Array(b)).platformType',list(data))=={'steam':1,'switch':9,'apple':7,'ps5':10}[target]
            result['actual_save_downloads']+=1
    if os.environ.get('HKIA_SCREENSHOT'):
        page.screenshot(path=os.environ['HKIA_SCREENSHOT'])
    # Mobile layout must remain readable with the prominent notice visible.
    page.set_viewport_size({'width':390,'height':844})
    mobile_width=page.evaluate('document.documentElement.scrollWidth')
    assert mobile_width<=390,f'Horizontal mobile overflow {mobile_width}'
    assert page.locator('#conversionFeedback').is_visible()
    if os.environ.get('HKIA_MOBILE_SCREENSHOT'):
        page.screenshot(path=os.environ['HKIA_MOBILE_SCREENSHOT'],full_page=True)
    page.set_viewport_size({'width':1440,'height':900})

    # Slot spelling matters. The binary is unchanged, name can include leading zeros.
    send(SRC[0].read_bytes(), 'save_0003.save')
    assert page.locator('.destination--switch').get_attribute('title')=='save_0003.save'
    with page.expect_download(timeout=60000) as entry:
        page.locator('.destination--switch').click()
    assert entry.value.suggested_filename=='save_0003.save'
    # Apple destination must keep the same save_<slot>.save convention.
    send(SRC[0].read_bytes(), 'save_0003.save')
    assert page.locator('.destination--apple').get_attribute('title')=='save_0003.save'
    with page.expect_download(timeout=60000) as entry:
        page.locator('.destination--apple').click()
    assert entry.value.suggested_filename=='save_0003.save'

    # Arbitrary filenames are valid input names when their BINARY is valid.
    # The complete original basename is used as the download filename, even
    # for non-.save extensions. No optional slot control is shown.
    send(SRC[0].read_bytes(), 'holiday_export.bin')
    assert page.locator('#platformName').inner_text()=='Steam'
    assert page.locator('#slotOverride').count()==0
    assert page.locator('#outputSlotInput').count()==0
    assert page.locator('.destination-button:enabled').count()==3
    assert page.locator('.destination--apple').get_attribute('title')=='holiday_export.bin'
    with page.expect_download(timeout=60000) as entry:
        page.locator('.destination--apple').click()
    assert entry.value.suggested_filename=='holiday_export.bin'
    with tempfile.TemporaryDirectory() as d:
        out=Path(d)/'holiday_export.bin'
        entry.value.save_as(out)
        assert page.evaluate('(b)=>window.__realParser.parseSave(new Uint8Array(b)).platformType',list(out.read_bytes()))==7
    result['filename_independent_conversion']=True

    # Keep arbitrary .save filenames byte-for-byte in the browser suggestion.
    send(SRC[0].read_bytes(), 'custom_backup.save')
    assert page.locator('.destination--switch').get_attribute('title')=='custom_backup.save'
    with page.expect_download(timeout=60000) as entry:
        page.locator('.destination--switch').click()
    assert entry.value.suggested_filename=='custom_backup.save'
    result['original_name_preserved']=True

    # No HeroesFate alias: unlike save_<slot>.save it is treated generically.
    send(SRC[1].read_bytes(), 'Save_HeroesFate_004.save')
    assert page.locator('#platformName').inner_text()=='Nintendo Switch'
    assert page.locator('.destination--steam').get_attribute('title')=='Save_HeroesFate_004.save'
    with page.expect_download(timeout=60000) as entry:
        page.locator('.destination--steam').click()
    assert entry.value.suggested_filename=='Save_HeroesFate_004.save'
    result['legacy_alias_removed']=True
    result['slot_preserved']=True

    # Standard names keep the compact approved UI with no extra slot control.
    send(SRC[0].read_bytes(), 'save_5.save')
    assert page.locator('#slotOverride').count()==0
    assert page.locator('.destination--apple').get_attribute('title')=='save_5.save'

    # Invalid file must fail before presenting actions.
    page.locator('#fileInput').set_input_files([{'name':'save_0.save','mimeType':'application/octet-stream','buffer':b'bad'}])
    page.locator('#errorView').wait_for(state='visible')
    result['bad_input_rejected']=True

    # Full save with its LZ4 region removed is NOT a valid downloadable output.
    test_bytes=SRC[0].read_bytes()
    magic=bytes.fromhex('a1a2f8333c66ec455baa2dfc6325c2437a779c9906eecff0c022e5f6b6ca73b8')
    assert magic in test_bytes
    send(test_bytes[:test_bytes.index(magic)])
    page.locator('.destination--switch').click()
    page.wait_for_timeout(100)
    assert 'failed verification' in page.locator('#conversionFeedback').inner_text().lower()
    assert 'feedback-error' in page.locator('#conversionFeedback').get_attribute('class')
    assert not any(f'feedback--{key}' in page.locator('#conversionFeedback').get_attribute('class') for key in ('steam','switch','apple','ps5'))
    result['notice_reset']=True
    result['missing_lz4_rejected_on_download']=True

    # Drag and drop: real browser DataTransfer object with actual File.
    bb=SRC[0].read_bytes()
    page.evaluate('''b=>{
      let dt=new DataTransfer();dt.items.add(new File([new Uint8Array(b)],'save_0.save',{type:'application/octet-stream'}));
      document.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));
      document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    }''',list(bb))
    page.locator('#successView').wait_for(state='visible')
    assert page.locator('#platformName').inner_text()=='Steam'
    result['drag_drop']=True
    assert not result['pageerrors'],result['pageerrors']
    browser.close()
print(json.dumps(result,ensure_ascii=False,indent=2))
assert result['actual_save_downloads']==6
print('PASS: Chromium native Blob-ESM actual parser/frontend with real binary save fixtures')
