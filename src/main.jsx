import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class StreamVGErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('StreamVG render error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{minHeight:'100vh',background:'#050505',color:'#f5f1e8',display:'grid',placeItems:'center',padding:32,fontFamily:'system-ui,sans-serif',textAlign:'center'}}>
          <div>
            <h1 style={{fontSize:32,margin:'0 0 12px'}}>StreamVG could not load</h1>
            <p style={{opacity:.72,maxWidth:520,margin:'0 auto'}}>A player component failed to start. Refresh once to load the current build.</p>
            <button onClick={()=>location.reload()} style={{marginTop:18,padding:'12px 20px',border:0,borderRadius:10,background:'#f2d18b',color:'#111',fontWeight:700,cursor:'pointer'}}>REFRESH STREAMVG</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StreamVGErrorBoundary>
    <App />
  </StreamVGErrorBoundary>
);
