function get(id) {
    return document.getElementById(id);
}

function adjustValue(elementId, up, max = 20, step = 1) {
    let el = get(elementId);
    let intv = parseInt(el.innerText, 10);
    
    if (up && intv < max) {
        el.innerText = intv + step;
    } else if (!up && intv > 0) {
        el.innerText = intv - step;
    }
}