# btw stand-in (test fixture)

This file stands in for the language reference when the generated btwsite/web/docs/BTW.md is not in the
working tree (that file is built from a private repository and is not committed). It is NOT the language:
a toy grammar under the same section headings the docs package looks for, so tests can run anywhere.

## The rules in one screen

- Toy rule one: a program is a list of lines.
- Toy rule two: decks are named A and B.

## Grammar (EBNF)

```ebnf
prog  = { stmt } ;
stmt  = tempo | deck ;
## this line is inside a code fence and is not a heading
tempo = "tempo" num ;
deck  = "deck" name ":" part { "|" part } ;
```

### Grammar: the additions

```ebnf
block = "section" name num "bars" "{" { stmt } "}" ;
```

### Which target takes which action

| action | deck | master |
|---|---|---|
| a toy part line | yes | no |

## Patterns: mini-notation

A toy section after the grammar, which llms-full.txt must not inline.

```text
# a comment inside a fence, not a heading
toy x ~ x ~
```
