const socket = io();

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


function cicleBetweenValues(id, left, values){
    const e = get(id);
    let cv = -1;
    for(let i = 0; i < values.length; i++){
        if(values[i] == e.innerText){
            cv = i;
            break;
        }
    }
    if(cv == -1){
        alert("Error!")
    }
    if(left){
        if(cv + 1 < values.length){
            e.innerText = values[cv + 1]
        }
        else{
           e.innerText =  values[0]
        }
    }
    else{
        if(cv > 0){
            e.innerText = values[cv - 1]
        }
        else{
           e.innerText = values[values.length - 1]
        }
    }
}