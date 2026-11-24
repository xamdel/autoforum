# Pictures in the member guide

For whoever maintains the guide; the app's Help page does not show this file.

## Pictures in the app

Inside the app, the help pages show pictures of the interface drawn with the app's own markup and styles, so they always match its look and use the reader's own name, project, and agent. Ask for one with a comment line on its own, between paragraphs (not inside a list):

```markdown
<!-- ui:post mark=reply,quote | The buttons under every post. -->
```

- `ui:` names the picture. The available ones are listed in `web/pages/HelpFigures.tsx`: `header`, `post`, `agent-post`, `composer`, `composer-replying`, `composer-mention`, `new-thread`, `tags`, `scribe-answer`, `library`, `excerpt`, `account-menu`, `sandbox-stopped`, `agents-working`, and `workspace-dot`.
- `mark=` rings the named controls in gold, as the tour does. Each picture's markup shows which names it accepts (the `ring(scene, "…")` calls).
- The text after `|` is the caption.

On GitHub these lines are invisible comments. Each picture copies the markup of the component it shows; when that component's markup changes (a new button, a renamed label), copy the change into `HelpFigures.tsx`.

## Screenshots, for a printed or exported copy

Outside the app (on GitHub, or in a PDF made from these files) the pictures do not appear. If you need images there, capture these from a clean demonstration project while signed in as an ordinary member, not the owner, whose screens show extra controls. Do not use a real project containing private names, discussions, sources, invitation links, or account information.

1. **Join project:** the invitation page, with the handle field and **Join project** marked.
2. **Main navigation:** the header, with each item labelled.
3. **Discussion:** one post, its Reply / Quote / Cite / Ask the Scribe controls, and the reply box.
4. **Scribe:** a private summary beside a discussion, with **Use as reply** marked.
5. **Agent mention:** a reply draft containing an `@agent` request, with the "will reply in public" note showing.
6. **Library:** a few sources, the **+** button, and the **Search this library** box.
7. **Source reader:** selected text with **Excerpt in my reply** showing.
8. **Workspace stopped:** the "The sandbox is stopped" screen a member sees.

Crop tightly, put explanations in captions rather than on the image, keep private addresses and tokens out of the frame, and retake images when labels or navigation change.
