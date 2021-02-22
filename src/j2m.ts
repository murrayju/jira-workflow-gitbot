// forked from https://github.com/FokkeZB/J2M

type Replacement = {
  key: string,
  value: string,
}

/**
 * Takes Markdown and converts it to Jira formatted text
 *
 * @param {string} input
 * @returns {string}
 */
export function markdownToJira(input: string) {
  // remove sections that shouldn't recursively processed
  const START = 'J2MBLOCKPLACEHOLDER';
  const replacementsList: Replacement[] = [];
  let counter = 0;

  input = input.replace(/`{3,}(\w+)?((?:\n|.)+?)`{3,}/g, function (_, synt, content) {
    let code = '{code';

    if (synt) {
      code += ':' + synt;
    }

    code += '}' + content + '{code}';
    const key = START + counter++ + '%%';
    replacementsList.push({ key: key, value: code });
    return key;
  });

  input = input.replace(/^(.*?)\n([=-])+$/gm, function (_, content, level) {
    return 'h' + (level[0] === '=' ? 1 : 2) + '. ' + content;
  });

  input = input.replace(/^([#]+)(.*?)$/gm, function (_, level, content) {
    return 'h' + level.length + '.' + content;
  });

  input = input.replace(/([*_]+)(.*?)\1/g, function (_, wrapper, content) {
    const to = wrapper.length === 1 ? '_' : '*';
    return to + content + to;
  });
  // Make multi-level bulleted lists work
  input = input.replace(/^(\s*)- (.*)$/gm, function (_, level, content) {
    let len = 2;
    if (level.length > 0) {
      len = Math.floor(level.length / 4.0) + 2;
    }
    return Array(len).join('-') + ' ' + content;
  });

  const map: { [key: string]: string } = {
    cite: '??',
    del: '-',
    ins: '+',
    sup: '^',
    sub: '~',
  };

  input = input.replace(
    new RegExp('<(' + Object.keys(map).join('|') + ')>(.*?)</\\1>', 'g'),
    (_, from, content) => {
      const to = map[from] || '';
      return to + content + to;
    },
  );

  input = input.replace(/~~(.*?)~~/g, '-$1-');

  input = input.replace(/`([^`]+)`/g, '{{$1}}');

  input = input.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');
  input = input.replace(/<([^>]+)>/g, '[$1]');

  // restore extracted sections
  for (let i = 0; i < replacementsList.length; i++) {
    const sub = replacementsList[i];
    input = input.replace(sub['key'], sub['value']);
  }

  // Convert header rows of tables by splitting input on lines
  const lines = input.split(/\r?\n/gm);
  for (var i = 0; i < lines.length; i++) {
    const line_content = lines[i];

    if (line_content.match(/\|---/g) != null) {
      lines[i - 1] = lines[i - 1].replace(/\|/g, '||');
      lines.splice(i, 1);
    }
  }

  // Join the split lines back
  input = '';
  for (var i = 0; i < lines.length; i++) {
    input += lines[i] + '\n';
  }
  return input;
}
