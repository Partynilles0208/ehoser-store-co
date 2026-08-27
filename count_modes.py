from pathlib import Path
import re
html = Path('public/index.html').read_text('utf-8')
card_modes = [m.group(1) for m in re.finditer(r"onclick=\"selectMode\('([^']+)'\)\"", html)]
print('total cards', len(card_modes))
uniq_cards = sorted(set(card_modes) - {'mode-select'})
print('unique modes', len(uniq_cards))
print('unique modes list:')
print('\n'.join(uniq_cards))
js = Path('public/app.js').read_text('utf-8')
mini_tool_modes = set()
mini_match = re.search(r"const MINI_TOOL_MODES\s*=\s*new Set\(\[([\s\S]*?)\]\);", js)
if mini_match:
    mini_tool_modes = set(re.findall(r"'([^']+)'", mini_match.group(1)))
else:
    definitions_match = re.search(r"const MINI_TOOL_DEFINITIONS\s*=\s*\{([\s\S]*?)\n\};", js)
    if definitions_match:
        mini_tool_modes = set(re.findall(r"^\s*([a-zA-Z0-9_]+)\s*:\s*\{", definitions_match.group(1), re.MULTILINE))
else_if_modes = set(re.findall(r"else if \(mode === '([^']+)'\)", js))
print('mini tool modes', len(mini_tool_modes))
print(sorted(mini_tool_modes))
print('else-if modes', len(else_if_modes))
print(sorted(else_if_modes)[:50])
missing = sorted([m for m in uniq_cards if m not in else_if_modes and m not in mini_tool_modes])
print('missing handlers', missing)
extra = sorted([m for m in sorted(else_if_modes|mini_tool_modes) if m not in uniq_cards and m != 'mode-select'])
print('extra handlers', extra)
