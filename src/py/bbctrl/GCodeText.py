# Reading G-code text the way the CAMotics planner reads it (1.29.0).
#
# The planner's tokenizer (CAMotics src/gcode/parse/Tokenizer.cpp):
#   - "(" starts a comment and the FIRST ")" ends it.  There is no nesting:
#     in "(a (b) c)" the comment is "(a (b)" and " c)" is read as code, which
#     stops the program with an error when the planner reaches that line.
#   - A "(" with no ")" on its line keeps going onto the next lines until a
#     ")" turns up.  Every line in between is skipped, moves included.
#   - ";" and "'" start a comment that runs to the end of the line.
#
# Everything on the controller that reads G-code text (Resume, camera
# alignment, the pre-run check) uses this module so it sees the same code the
# planner will run, and can say where a comment will go wrong.

import re

WORD = re.compile(r'([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))')


class Issue(object):
    # kind: 'nested'   a "(" inside a comment
    #       'stray'    a ")" outside any comment
    #       'unclosed' a "(" with no ")" before the end of the line
    #       'quote'    an apostrophe outside a comment
    def __init__(self, kind, col):
        self.kind = kind
        self.col = col

    def __repr__(self): return 'Issue(%s, %d)' % (self.kind, self.col)


def split(line, in_comment = False):
    '''Splits one line like the planner does.

    in_comment: the line starts inside a "(" comment left open on an earlier
    line.  Returns (code, comments, issues, in_comment_after): code has every
    comment replaced by a space, comments is the list of comment texts
    (without their brackets), issues lists anything that looks wrong.'''
    code = []
    comments = []
    issues = []
    cur = [] if in_comment else None
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if cur is not None:
            if c == ')':
                comments.append(''.join(cur))
                cur = None
                code.append(' ')
            else:
                if c == '(': issues.append(Issue('nested', i))
                cur.append(c)
        elif c == '(':
            cur = []
        elif c in ';\'':
            # The planner sends both to its ";" comment reader, which only
            # expects ";", so an apostrophe out here may stop it with an error
            if c == '\'': issues.append(Issue('quote', i))
            comments.append(line[i + 1:])
            break
        else:
            if c == ')': issues.append(Issue('stray', i))
            code.append(c)
        i += 1

    if cur is not None:
        comments.append(''.join(cur))
        issues.append(Issue('unclosed', n))

    return ''.join(code), comments, issues, cur is not None


def code_of(line):
    '''The code part of a line read on its own (comments removed).'''
    return split(line)[0]


def problem_text(issues):
    kinds = set(i.kind for i in issues)
    if 'nested' in kinds and 'stray' in kinds:
        return ('a comment has brackets inside it, like "(a (b) c)". The '
                'planner ends the comment at the first ")" and reads the rest '
                'as code, so the job stops with an error on this line')
    if 'nested' in kinds:
        return ('a comment has a "(" inside it. The planner ends the comment at '
                'the first ")", so anything after it on this line is read as '
                'code')
    if 'stray' in kinds:
        return ('there is a ")" outside any comment. The planner reads it as '
                'code and stops with an error on this line')
    if 'unclosed' in kinds:
        return ('a comment is opened with "(" and never closed on this line. '
                'The planner carries on reading the next lines as comment '
                'until it finds a ")", so the moves on those lines are skipped')
    if 'quote' in kinds:
        return ('there is an apostrophe outside a comment. The planner treats '
                'it as the start of a comment and may stop with an error')
    return ''


def safe_comment(text):
    '''Text that can go inside a generated "( ... )" comment: brackets become
    square brackets, so the comment always ends where it is meant to.'''
    return (str(text).replace('(', '[').replace(')', ']')
            .replace('\r', ' ').replace('\n', ' '))


# Setup sheet lines written by the post processor, "(SETUP key: text)".  Same
# rules as the UI's setup.js: the sheet ends at the first line of real code.
SETUP_LINE = re.compile(r'^\s*\(\s*SETUP\s+([A-Za-z0-9-]+)\s*:\s*(.*?)\s*\)\s*$')
FIRST_CODE = re.compile(r'^\s*N?\d*\s*[GMTXYZ]', re.I)


def setup_fields(lines):
    '''{key: text} from the setup sheet at the top of a program, plus
    '_bad': [line numbers] of SETUP lines whose brackets the planner will
    read differently (nested or unbalanced).'''
    fields = {}
    bad = []
    for n, line in enumerate(lines, 1):
        m = SETUP_LINE.match(line)
        if m:
            fields[m.group(1).lower()] = m.group(2)
            if split(line)[2]: bad.append(n)
            continue
        if FIRST_CODE.match(line) and not re.match(r'^\s*\(', line): break
    if bad: fields['_bad'] = bad
    return fields


CORNERS = ('front-left', 'front-right', 'back-left', 'back-right', 'center',
           'center-x')


def norm_corner(text):
    '''"FRONT LEFT", "front_left" -> "front-left".  None when empty.'''
    if not text: return None
    return re.sub(r'[\s_]+', '-', str(text).strip().lower())
