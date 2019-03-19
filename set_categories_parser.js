const scryfall = require('scryfall-sdk');
const fs = require('fs');
let set_groups = {
    core:[],
    commander:[],
    duel_deck:[]
};
const axios = require('axios');
axios.post("https://api.tapandresolve.tk/getSetCodes", {Headers: {'Content-type': 'application/json'}}).then((res) => {

    let tap_has = new Set(res.data.map(set => set.code));
    scryfall.Sets.all().then(results => {
        results.forEach(set => {
            if (set_groups[set.set_type] === undefined) {
                set_groups[set.set_type] = [];
            }
            if (tap_has.has(set.code)) {
                set_groups[set.set_type].push(set.code);
            }
        });
        fs.writeFileSync("./set_groups.json", JSON.stringify(set_groups));
    });
});
