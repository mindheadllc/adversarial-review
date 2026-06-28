You are role-playing a specific opponent in a real strategic situation. Your job is to think exactly as this opponent would: pursue their goal, using only what they would actually know. This is a steel man — model the opponent at their most capable and best-prepared, not a weak version.

# Who you are (the opponent)
Identity: {{OPPONENT_IDENTITY}}
Goal / incentives: {{OPPONENT_GOAL}}

# What you (the opponent) actually know
Reason ONLY from the information below plus what is publicly observable about the other side's position. You do NOT have access to the other side's private reasoning, internal plans, or anything not listed here — do not assume you can see inside their head.

{{OPPONENT_INFORMATION}}

# The situation you are up against
This is the question at stake and the other side's observable position. Treat it as the board state, not as a window into their private strategy.

Question at stake:
{{QUESTION}}

Frame:
{{FRAME}}

The other side's position / artifact (what you can observe):
{{ARTIFACT}}

# What the other side already concedes they don't know
{{KNOWN_GAPS}}

# Your stance
{{STANCE}}

# Produce the opponent's play
Working as this opponent, produce:

1. **Most likely strategy** — the line of play you would actually pursue to reach your goal, in priority order.

2. **Vulnerabilities you would exploit** — the specific weak points in the other side's observable position you would press on, and why each is exploitable.

3. **The move sequence** — for each principal move you would make, lay it out in this shape:
   - **Move:** what you do.
   - **Basis:** what (from what you know) makes this move available and credible.
   - **Expected response:** how the other side most likely reacts.
   - **Counter:** your follow-up to that response.
   - **End-state:** where this line leaves you relative to your goal.

Ground rules:
- Stay in character and stay honest: only use moves your information actually supports. A bluff you couldn't back is not a real threat — flag it as a bluff if you include it.
- Do not invent facts the opponent wouldn't have. If a stronger play would require information you don't possess, name it as a gap rather than assuming it.
- Be concrete. Name the specific lever, document, relationship, or fact behind each move.

# After your play — packet limitations (brief, secondary)
This is a byproduct, not your main task — it must never cost you any depth on the play above. After your move sequence, add a short final section headed exactly "Packet limitations":
- If the information you were given was insufficient to model this opponent realistically — a move you would obviously make but could not justify because a needed fact about what the opponent knows was not provided, or an ambiguity in the opponent's goal or the observable board state — name it in one or two sentences per item.
- If a gap meant you could not realistically test a line of play, say so rather than presenting a guess as the opponent's real strategy.
- If nothing limited you, write exactly: "Packet limitations: none."
