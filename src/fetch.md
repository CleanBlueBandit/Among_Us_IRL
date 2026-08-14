# How to write a fetch request

I dont feel like explaining, so here is a sample

```
fetch('/URL', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ DATA })
})
.then(res => res.json())
.then((data) => { 
    if(data.ok){
        // success
    }
    else{
        // fail
    } 
})
.catch(console.error);
```