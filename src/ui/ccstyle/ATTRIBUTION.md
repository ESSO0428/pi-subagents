# Attribution

The viewer-local ccstyle tool-card and diff renderer are adapted from
`@herbertgao/pi-cc-extensions` version `0.9.0`, specifically its
`extensions/renderer/tool/result.ts` and
`extensions/renderer/tool/diff/` modules.

The adaptation is local to this package and changes the configuration boundary,
write payload handling, width guards, and syntax highlighting fallback. It does
not install `@shikijs/cli`, patch Pi prototypes, or register global terminal
handlers. The local copy uses Pi's public `highlightCode` API and plain text
when highlighting is unavailable.

The source package is distributed under the MIT License. The relevant license
text is reproduced below:

> MIT License
>
> Copyright (c) 2026 Herbert Gao and pi-cc-extensions contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
