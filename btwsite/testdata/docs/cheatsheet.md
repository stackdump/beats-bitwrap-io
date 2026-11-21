# btw cheat-sheet (test fixture)

Stand-in for the output of `btwd cheatsheet` when btwsite/web/docs/cheatsheet.md has not been generated.

```text
toy tempo 120
toy deck A: kick x ~ x ~
```

## A first beat

A whole program, tagged `btw`: the HTML page highlights it and offers "Try it".

```btw
# a four-line beat
tempo 124
deck A: kick x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ | snare ~ ~ ~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~ | hihat ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ vel=60..90
deck B: bass a2 ~ ~ a2 ~ ~ a2 ~ ~ ~ c3 ~ e2 ~ ~ ~ inst=sub-bass | harmony chord(am) inst=warm-pad
end at bar 8
```
