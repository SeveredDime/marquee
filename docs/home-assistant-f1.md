# Formula 1 screens (Home Assistant)

Marquee can show live Formula 1 timing on the display. It reads the data from the
[F1 Sensor](https://github.com/Nicxe/f1_sensor) integration in Home Assistant.

## Setup

1. In Home Assistant, install **F1 Sensor** from HACS and add the integration.
2. In the integration's options, make sure these sensors are turned on:
   **top three**, **driver positions**, **driver list**, **current session**,
   **session status**, **track status**, **race lap count**, **next race**,
   **race week** and **driver standings**.
3. In Home Assistant, open your profile, go to **Security**, and create a
   **long-lived access token**.
4. In the Marquee template, set **Home Assistant URL** (for example
   `http://192.168.1.100:8123`) and paste the token into **Home Assistant Token**.
5. Restart Marquee. The container log says `F1: live updates connected` when it works.

Marquee only reads from Home Assistant. It never changes anything there.

## What you'll see

| When | Screen |
|---|---|
| Race week | A countdown card with the circuit outline, and the top-5 driver standings, mixed into the poster slideshow (`F1_CARDS_EVERY`) |
| Live session | The leader's photo in team colours, the lap count, and P2/P3 with gaps. Practice and qualifying say e.g. "Qualifying leader" |
| Yellow flag, safety car, VSC, red flag | A coloured banner across the top |
| Pit stop or new fastest lap | A short pop-up |
| Race finished | The winner and podium for `F1_WINNER_MINUTES` |

A movie playing on a theater player still wins: the screen stays black.

## Lining it up with your TV

The F1 Sensor integration has a **Live delay** setting (`number.f1_live_delay`).
Raise it if the display is ahead of your TV broadcast, lower it if it's behind.
Marquee itself updates within about a second of Home Assistant.

## Watching a replay

F1 Sensor's **Replay mode** plays back the timing data of a past session (it needs
F1 TV access set up in the integration). Marquee treats a playing replay like a live session.
The replay is data only: you watch the race video yourself, for example in the F1 TV app.

1. Pick the session in **select.f1_replay_session** and press **Load**.
2. Start the race video and pause it as the formation lap begins.
3. Press **Play** on the replay and unpause the video at the same moment.

### Optional: pause the replay with your TV

If your streaming box shows up in Home Assistant as a media player, this automation
pauses and resumes the replay when you pause and play the F1 TV app. Change the
media player to yours. Skipping forward or back is not followed, because the app
doesn't report its position.

```yaml
alias: F1 Replay follows TV play/pause
mode: queued
triggers:
  - trigger: state
    entity_id: media_player.your_tv_box
    to: paused
    id: pause
  - trigger: state
    entity_id: media_player.your_tv_box
    to: playing
    id: play
conditions:
  - condition: state
    entity_id: media_player.your_tv_box
    attribute: app_id
    state: com.formulaone.production
actions:
  - choose:
      - conditions:
          - condition: trigger
            id: pause
          - condition: state
            entity_id: sensor.f1_replay_status
            state: playing
        sequence:
          - action: button.press
            target:
              entity_id: button.f1_replay_pause
      - conditions:
          - condition: trigger
            id: play
          - condition: state
            entity_id: sensor.f1_replay_status
            state: paused
        sequence:
          - action: button.press
            target:
              entity_id: button.f1_replay_play
```

## Different entity names

If your entities are named differently, point Marquee at them with
`F1_LEADER_ENTITY`, `F1_SESSION_ENTITY`, `F1_DRIVERS_ENTITY`, `F1_LAP_ENTITY`,
`F1_POSITIONS_ENTITY`, `F1_TRACK_ENTITY`, `F1_STATUS_ENTITY`, `F1_NEXT_RACE_ENTITY`,
`F1_RACE_WEEK_ENTITY`, `F1_STANDINGS_ENTITY` and `F1_REPLAY_ENTITY`.
