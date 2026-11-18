# btw stand-in (test fixture)

This file stands in for docs/BTW.md of the private language repository when the generated
btwsite/web/docs/BTW.md is not in the working tree. It is NOT the language reference: it has the same
section headings the docs package looks for, and a few lines under each, so tests can run anywhere.

## The rules in one screen

- A program is lines. A line is blank, a `# comment`, or one statement.
- Deck names are `A` and `B`.

## Grammar (EBNF)

```ebnf
program   = { line } ;
line      = [ statement ] [ comment ] NEWLINE ;
comment   = "#" { any character but NEWLINE } ;
statement = setting | deck ;
## this line is inside a code fence and is not a heading
setting   = "tempo" number ;
deck      = "deck" ( "A" | "B" ) ":" part { "|" part } ;
```

### Grammar: the additions

```ebnf
section = "section" NAME int "bars" "{" { statement } "}" ;
```

### Which target takes which action

| action | deck | master |
|---|---|---|
| a part line | yes | no |

## Patterns: mini-notation

`x` is a hit and `~` a rest.

```text
# a comment inside a fence, not a heading
kick x ~ x ~
```
