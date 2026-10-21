## Placement rules

### Realistic sizes (feet)
- Use the type's typical size unless the description says otherwise, and stay inside its min/max.
- Wagon about 10 x 5 (cart 8 x 4). Mature tree canopy 15-25 (young 8-12, ancient 28-35). Bush 3-8. Boulder 3-10. Crate 2-4, barrel 2.5.
- Cottage about 30 x 20, barn 40 x 30, shed 12 x 10, watchtower 15-20 (shape round). A-frame tent 8 x 6, round tent 12, pavilion 20-25.
- Road 10-15 wide (cart track 8-10). Stream 5-15 wide, river 20-40. Footbridge 5 wide, road bridge 10-15 wide; a bridge's length (size.w) spans the whole water width plus 2-4 ft on each bank, rotated so w runs across the water.
- One creature occupies a 5 x 5 ft square. Design spaces in 5 ft squares.

### Spacing and collisions
- Respect each type's `blockedBy`: an element may not overlap anything whose category is in its blockedBy list (and vice versa). Trees, boulders, bushes, buildings and tents never sit on roads or in water. Wagons, crates, barrels and campfires may sit on roads. Only bridges sit on water. Nothing overlaps walls, fences or cliff edges.
- Collision uses the footprint (trees: 45 % of the canopy, so canopies may overlap a little). Keep at least each type's `minGapFt` between blocking footprints. Do not stack objects accidentally; when things touch, it is on purpose (crates against a wagon, barrels in a group).
- Keep every object's footprint fully inside the map. Tree canopies may overhang the map edge.
- Leave movement lanes: at least one 5 ft (better 10 ft) wide route across the map west to east and north to south, plus room to move around every major feature. Do not wall off areas unless the description asks for it.

### Cover and tactics
- Most open ground should be within 15-30 ft of something that gives cover (trees, boulders, rock clusters, wagons, walls, buildings, crates, tents). Aim for at least 60 % of open squares within 30 ft of cover.
- Mix open ground (where fights happen) with cover at varied distances. Give both sides of an encounter some cover. Put ambushers' cover 15-30 ft from where the victims are.

### Stated distances are exact
- EVERY distance the user states ("20 ft west of", "30 feet from", "a stone's throw" does not count, a number does) becomes one entry in `constraints`, and the positions you write must already satisfy it.
- `a` is the anchor (the thing the distance is measured from), `b` is the element that is that far away. `direction` is where b lies relative to a (north, south, east, west, northeast, northwest, southeast, southwest, or any). `measure` is `edge` (default: gap between the visible edges, e.g. canopy edge, road edge, building wall) or `center` (centre to centre, only when the user clearly means centres).
- Example: "a second wagon 20 ft west of the wreck" -> `{"id":"c-wagons","kind":"distance","a":"wagon-wreck","b":"wagon-rear","ft":20,"measure":"edge","direction":"west","text":"second wagon 20 ft west of the wreck"}`, and wagon-rear's east edge is exactly 20 ft west of wagon-wreck's west edge. Compute positions with the element sizes (a 10 x 5 wagon at x = 50 spans x 45-55). A path's edge is its centreline offset by width / 2.
- A stated range ("15-25 ft from the road") is not exact: place things inside the range, no constraint needed.
- A distance stated for a group ("two wagons 15 ft west of the bridge") gets ONE constraint, on the group member nearest to `a`. Place the other members beside it (side by side or in a short line, 2-5 ft apart, never overlapping) without their own constraint, so the solver cannot stack them on one spot.

### Natural variety (make it look good)
- Natural maps need many elements: a forest edge has dozens of trees, not five. Vary tree sizes (+-30 %) and species, cluster them irregularly, leave clearings. Add bushes under and between trees, scattered boulders and rock clusters.
- Use regions for ground variation: tall-grass patches, dirt or mud patches near roads and camps, moss under trees, gravel or rubble near ruins. Polygons should be irregular (6-12 points), not rectangles.
- Paths should curve gently (4-8 points), not run as straight lines, unless they are built walls or fences.
- Use rotation on objects (wagons, crates, boulders, tents) so nothing looks gridded. Avoid perfectly regular rows unless the scene is built (a fence, a market).
- Give elements short descriptive names ("Old oak", "Overturned wagon") and ids in kebab-case (`tree-12`, `wagon-wreck`).
