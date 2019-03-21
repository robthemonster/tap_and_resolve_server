const scryfall = require('scryfall-sdk');
const fs = require('fs');
let set_groups = {
    core: [],
    commander: [],
    duel_deck: []
};
let set_icons = {};
const axios = require('axios');
axios.post("https://api.tapandresolve.tk/getSetCodes", {Headers: {'Content-type': 'application/json'}}).then((res) => {
    let tap_has = new Set(res.data.map(set => set.code));
    scryfall.Sets.all().then(results => {
        results.forEach(set => {
            if (set_groups[set.set_type] === undefined) {
                set_groups[set.set_type] = [];
            }
            if (tap_has.has(set.code)) {
                set_icons[set.code] = set.icon_svg_uri;
                set_groups[set.set_type].push(set.code);
            }
        });
        fs.writeFileSync('./set_icons.json', JSON.stringify(set_icons));
        fs.writeFileSync("./set_groups.json", JSON.stringify(set_groups));
    });
});
